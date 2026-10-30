const ACTIVE_PADDLE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

export function normalizePaddleEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const eventId = event.eventId || event.event_id;
  const eventType = event.eventType || event.event_type;
  const data = event.data;
  if (typeof eventId !== 'string' || !eventId || typeof eventType !== 'string' || !data || typeof data !== 'object') return null;
  const occurredAt = event.occurredAt || event.occurred_at || null;
  return { eventId, eventType, data, occurredAt };
}


export function isPremiumCheckoutBlocked(user, now = Date.now()) {
  if (isPremiumEntitlementActive(user, now)) return true;
  const subscriptionId = user?.paddle_subscription_id;
  const status = String(user?.paddle_subscription_status || '').toLowerCase();
  return typeof subscriptionId === 'string' && subscriptionId.length > 0 &&
    !['canceled', 'completed'].includes(status);
}

export function isPremiumEntitlementActive(user, now = Date.now()) {
  if (!user || typeof user !== 'object' || !Number.isFinite(now)) return true;
  if (user.premium_lifetime === true) return true;
  const value = user.premium_until;
  if (value === null || value === undefined || value === '') return false;
  const end = value instanceof Date ? value.getTime() : Date.parse(value);
  // Corrupt persisted entitlement data must not permit a second charge.
  return !Number.isFinite(end) || end > now;
}

export function isPaddleSubscriptionEntitled(status, periodEnd, now = Date.now()) {
  if (!ACTIVE_PADDLE_SUBSCRIPTION_STATUSES.has(String(status || '').toLowerCase())) return false;
  if (!periodEnd) return false;
  const end = Date.parse(periodEnd);
  return Number.isFinite(end) && end > now;
}

export async function processPaddleEvent(pool, rawEvent) {
  const event = normalizePaddleEvent(rawEvent);
  if (!event) throw new Error('invalid_paddle_event');

  const { eventId, eventType, data, occurredAt } = event;
  const subscriptionLifecycleEvent = ['subscription.created', 'subscription.updated', 'subscription.canceled'].includes(eventType);
  // Paddle lifecycle events must carry their source timestamp. Without it we cannot
  // safely order updates, so fail closed instead of allowing an older event to win.
  if (subscriptionLifecycleEvent && (!occurredAt || !Number.isFinite(Date.parse(occurredAt)))) {
    throw new Error('invalid_paddle_event_timestamp');
  }
  // Never grant or revoke subscription entitlement from a lifecycle envelope
  // that cannot identify the Paddle subscription being reconciled.
  if (subscriptionLifecycleEvent && (typeof data.id !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(data.id))) {
    throw new Error('invalid_paddle_subscription_id');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
      [eventId, eventType]
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true, handled: false };
    }

    const customData = data.customData || data.custom_data || {};
    const rawCustomUserId = typeof customData.userId === 'string' ? customData.userId
      : typeof customData.user_id === 'string' ? customData.user_id : null;
    // Paddle custom_data is external input; avoid passing malformed identifiers into
    // PostgreSQL UUID casts, which would turn a bad metadata value into endless webhook retries.
    const customUserId = rawCustomUserId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCustomUserId)
      ? rawCustomUserId
      : null;
    const subscriptionId = typeof data.id === 'string' && eventType.startsWith('subscription.')
      ? data.id
      : typeof data.subscriptionId === 'string' ? data.subscriptionId
        : typeof data.subscription_id === 'string' ? data.subscription_id : null;
    const customerId = typeof data.customerId === 'string' ? data.customerId
      : typeof data.customer_id === 'string' ? data.customer_id
        : (eventType === 'customer.created' || eventType === 'customer.updated') && typeof data.id === 'string' ? data.id : null;

    if (['subscription.created', 'subscription.updated', 'subscription.canceled'].includes(eventType)) {
      const status = eventType === 'subscription.canceled' ? 'canceled' : String(data.status || '').toLowerCase();
      const periodEnd = data.currentBillingPeriod?.endsAt || data.current_billing_period?.ends_at || null;
      const firstItem = Array.isArray(data.items) ? data.items[0] : null;
      const priceId = firstItem?.price?.id || firstItem?.priceId || firstItem?.price_id || null;
      // A valid Paddle subscription is not sufficient by itself: only the recurring
      // price IDs explicitly configured for Vow Premium may grant subscription access.
      // Missing configuration or an unrelated Paddle product must fail closed.
      const allowedRecurringPriceIds = new Set([
        process.env.PADDLE_PRICE_ID_1MONTH,
        process.env.PADDLE_PRICE_ID_3MONTHS
      ].filter(value => typeof value === 'string' && /^pri_[A-Za-z0-9]+$/.test(value)));
      const active = allowedRecurringPriceIds.has(priceId)
        && isPaddleSubscriptionEntitled(status, periodEnd);
      const subscriptionUpdate = await client.query(
        `UPDATE users SET
          paddle_customer_id = COALESCE($2, paddle_customer_id),
          paddle_subscription_id = COALESCE($3, paddle_subscription_id),
          paddle_subscription_status = $4,
          paddle_price_id = COALESCE($5, paddle_price_id),
          paddle_subscription_updated_at = COALESCE($8::timestamptz, NOW()),
          premium_until = CASE WHEN $6::boolean THEN $7::timestamptz ELSE NULL END,
          premium_lifetime = CASE WHEN $6::boolean THEN FALSE ELSE premium_lifetime END,
          updated_at = NOW()
        WHERE id = COALESCE($1::uuid, (SELECT id FROM users WHERE paddle_subscription_id = $3 LIMIT 1))
          AND users.status = 'active'
          AND (paddle_subscription_updated_at IS NULL OR $8::timestamptz >= paddle_subscription_updated_at)
          -- Never let custom_data reassign a subscription or customer already owned by another account.
          AND ($3::text IS NULL OR NOT EXISTS (
            SELECT 1 FROM users AS other
            WHERE other.paddle_subscription_id = $3 AND other.id <> users.id
          ))
          AND ($2::text IS NULL OR NOT EXISTS (
            SELECT 1 FROM users AS other
            WHERE other.paddle_customer_id = $2 AND other.id <> users.id
          ))
          -- Do not silently replace this account's established Paddle identities.
          AND ($3::text IS NULL OR paddle_subscription_id IS NULL OR paddle_subscription_id = $3
            OR ($9::boolean AND lower(paddle_subscription_status) IN ('canceled', 'completed')))
          AND ($2::text IS NULL OR paddle_customer_id IS NULL OR paddle_customer_id = $2)
          -- A new subscription may replace only a terminal prior subscription, never an active one.
          -- The source timestamp guard above prevents a delayed old lifecycle event from winning.
          -- A delayed or newly delivered subscription event must not revoke or replace lifetime Premium.
          AND premium_lifetime IS NOT TRUE`,
        [customUserId, customerId, subscriptionId, status, priceId, active, active ? periodEnd : null, occurredAt, eventType === 'subscription.created']
      );
      const checkoutPlan = priceId === process.env.PADDLE_PRICE_ID_1MONTH ? '1month'
        : priceId === process.env.PADDLE_PRICE_ID_3MONTHS ? '3months' : null;
      if (active && customUserId && checkoutPlan && subscriptionUpdate.rowCount > 0) {
        await client.query(
          `UPDATE paddle_checkout_attempts
           SET status = 'linked', updated_at = NOW()
           WHERE user_id = $1 AND plan = $2 AND status IN ('pending', 'completed')`,
          [customUserId, checkoutPlan]
        );
      }
    } else if (eventType === 'transaction.completed') {
      // A verified completed transaction can grant the one-time lifetime plan,
      // but only when its server-configured Paddle price matches the expected price.
      const transactionItems = Array.isArray(data.items) ? data.items : [];
      const lifetimePriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
      const includesLifetimePrice = Boolean(lifetimePriceId) && transactionItems.some(item =>
        (item?.priceId || item?.price_id || item?.price?.id) === lifetimePriceId
      );
      if (customData.plan === 'lifetime' && includesLifetimePrice && customUserId) {
        await client.query(
          `UPDATE users SET
            paddle_customer_id = COALESCE($2, paddle_customer_id),
            paddle_subscription_id = NULL,
            paddle_subscription_status = 'completed',
            paddle_price_id = $3,
            premium_lifetime = TRUE,
            premium_until = NULL,
            updated_at = NOW()
          WHERE id = $1::uuid AND users.status = 'active'
            AND ($2::text IS NULL OR NOT EXISTS (
              SELECT 1 FROM users AS other
              WHERE other.paddle_customer_id = $2 AND other.id <> users.id
            ))
            -- Do not detach an existing active subscription to grant lifetime access.
            -- Subscription cancellation/reconciliation must be handled separately first.
            AND (paddle_subscription_id IS NULL OR lower(paddle_subscription_status) IN ('canceled', 'completed'))
            -- A transaction may confirm the same customer, but cannot swap account identity.
            AND ($2::text IS NULL OR paddle_customer_id IS NULL OR paddle_customer_id = $2)`,
          [customUserId, customerId, lifetimePriceId]
        );
      } else {
        // Recurring subscriptions are provisioned only by verified subscription
        // lifecycle events, never by the checkout redirect or transaction alone.
        await client.query(
          `UPDATE users SET
            paddle_customer_id = COALESCE($2, paddle_customer_id),
            paddle_subscription_id = COALESCE($3, paddle_subscription_id),
            updated_at = NOW()
          WHERE id = COALESCE($1::uuid, (SELECT id FROM users WHERE paddle_subscription_id = $3 LIMIT 1))
            AND users.status = 'active'
            AND ($3::text IS NULL OR NOT EXISTS (
              SELECT 1 FROM users AS other
              WHERE other.paddle_subscription_id = $3 AND other.id <> users.id
            ))
            AND ($2::text IS NULL OR NOT EXISTS (
              SELECT 1 FROM users AS other
              WHERE other.paddle_customer_id = $2 AND other.id <> users.id
            ))
            -- A transaction may confirm existing identities, not replace them.
            AND ($2::text IS NULL OR paddle_customer_id IS NULL OR paddle_customer_id = $2)
            AND ($3::text IS NULL OR paddle_subscription_id IS NULL OR paddle_subscription_id = $3)`,
          [customUserId, customerId, subscriptionId]
        );
      }
      if (typeof data.id === 'string') {
        await client.query(
          `UPDATE paddle_checkout_attempts SET status = 'completed', updated_at = NOW()
           WHERE transaction_id = $1 AND status = 'pending'`,
          [data.id]
        );
      }
    } else if (eventType === 'customer.created' || eventType === 'customer.updated') {
      const customerEmail = data.email;
      if (customUserId && customerId && typeof customerEmail === 'string') {
        await client.query(
          `UPDATE users SET paddle_customer_id = COALESCE($2, paddle_customer_id), updated_at = NOW()
           WHERE id = $1::uuid AND users.status = 'active' AND lower(email) = lower($3)
             AND (paddle_customer_id IS NULL OR paddle_customer_id = $2)
             AND NOT EXISTS (
               SELECT 1 FROM users AS other
               WHERE other.paddle_customer_id = $2 AND other.id <> users.id
             )`,
          [customUserId, customerId, customerEmail]
        );
      }
    }

    await client.query('COMMIT');
    return { duplicate: false, handled: ['subscription.created', 'subscription.updated', 'subscription.canceled', 'transaction.completed', 'customer.created', 'customer.updated'].includes(eventType) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


function isValidPaddleCustomerId(value) {
  return typeof value === 'string' && /^ctm_[A-Za-z0-9]+$/.test(value);
}

function isValidPaddleSubscriptionId(value) {
  return typeof value === 'string' && /^sub_[A-Za-z0-9]+$/.test(value);
}

function trustedPaddlePortalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'customer-portal.paddle.com' ||
        parsed.username || parsed.password || parsed.port) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Create a short-lived, authenticated Paddle Customer Portal link for the signed-in account. */
export async function createPaddleCustomerPortalSession({
  apiKey,
  environment = 'sandbox',
  customerId,
  subscriptionId = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (environment !== 'sandbox' || typeof apiKey !== 'string' || !apiKey ||
      !isValidPaddleCustomerId(customerId) ||
      (subscriptionId !== null && !isValidPaddleSubscriptionId(subscriptionId)) ||
      typeof fetchImpl !== 'function') {
    throw new Error('paddle_portal_not_configured');
  }

  const response = await fetchImpl(
    `https://sandbox-api.paddle.com/customers/${encodeURIComponent(customerId)}/portal-sessions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': '1'
      },
      body: JSON.stringify(subscriptionId ? { subscription_ids: [subscriptionId] } : {}),
      signal: AbortSignal.timeout(10_000)
    }
  );
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  if (!response.ok || data?.customer_id !== customerId) {
    throw new Error('paddle_portal_session_failed');
  }

  const subscriptionLink = Array.isArray(data.urls?.subscriptions)
    ? data.urls.subscriptions.find(item => item?.id === subscriptionId)
    : null;
  const url = trustedPaddlePortalUrl(
    subscriptionLink?.view_subscription || subscriptionLink?.cancel_subscription || data.urls?.general?.overview
  );
  if (!url) throw new Error('paddle_portal_url_invalid');
  return { url, subscriptionId: subscriptionId || null };
}

/** Immediately stop renewal before account deletion; never report success without Paddle confirmation. */
export async function cancelPaddleSubscription({
  apiKey,
  environment = 'sandbox',
  subscriptionId,
  customerId,
  fetchImpl = globalThis.fetch
} = {}) {
  if (environment !== 'sandbox' || typeof apiKey !== 'string' || !apiKey ||
      !isValidPaddleSubscriptionId(subscriptionId) || !isValidPaddleCustomerId(customerId) ||
      typeof fetchImpl !== 'function') {
    throw new Error('paddle_cancellation_not_configured');
  }

  const response = await fetchImpl(
    `https://sandbox-api.paddle.com/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': '1'
      },
      body: JSON.stringify({ effective_from: 'immediately' }),
      signal: AbortSignal.timeout(10_000)
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.data?.id !== subscriptionId || payload?.data?.customer_id !== customerId ||
      String(payload?.data?.status || '').toLowerCase() !== 'canceled') {
    throw new Error('paddle_subscription_cancel_unconfirmed');
  }
  return { subscriptionId, status: 'canceled' };
}


function isValidPaddleTransactionId(value) {
  return typeof value === 'string' && /^txn_[A-Za-z0-9]+$/.test(value);
}

async function fetchPaddleTransaction({ apiKey, transactionId, expectedUserId, expectedPlan, fetchImpl }) {
  if (typeof apiKey !== 'string' || !apiKey || !isValidPaddleTransactionId(transactionId) ||
      typeof expectedUserId !== 'string' || !expectedUserId ||
      !['1month', '3months', 'lifetime'].includes(expectedPlan) || typeof fetchImpl !== 'function') {
    throw new Error('paddle_transaction_lookup_not_configured');
  }
  const response = await fetchImpl(
    `https://sandbox-api.paddle.com/transactions/${encodeURIComponent(transactionId)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Paddle-Version': '1' },
      signal: AbortSignal.timeout(10_000)
    }
  );
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  if (!response.ok || data?.id !== transactionId ||
      data?.custom_data?.userId !== expectedUserId ||
      data?.custom_data?.plan !== expectedPlan) {
    throw new Error('paddle_transaction_ownership_unconfirmed');
  }
  return { id: transactionId, status: String(data.status || '').toLowerCase() };
}

/** Read provider state before reusing or canceling a previously-created checkout transaction. */
export async function getPaddleCheckoutTransaction({
  apiKey,
  environment = 'sandbox',
  transactionId,
  expectedUserId,
  expectedPlan,
  fetchImpl = globalThis.fetch
} = {}) {
  if (environment !== 'sandbox') throw new Error('paddle_transaction_lookup_not_configured');
  return fetchPaddleTransaction({ apiKey, transactionId, expectedUserId, expectedPlan, fetchImpl });
}

/** Cancel only an unpaid draft/ready transaction that is proven to belong to this user and plan. */
export async function cancelPaddleCheckoutTransaction({
  apiKey,
  environment = 'sandbox',
  transactionId,
  expectedUserId,
  expectedPlan,
  fetchImpl = globalThis.fetch
} = {}) {
  if (environment !== 'sandbox') throw new Error('paddle_transaction_cancel_not_configured');
  const transaction = await fetchPaddleTransaction({
    apiKey, transactionId, expectedUserId, expectedPlan, fetchImpl
  });
  if (transaction.status === 'canceled') return transaction;
  if (!['draft', 'ready'].includes(transaction.status)) return transaction;

  const response = await fetchImpl(
    `https://sandbox-api.paddle.com/transactions/${encodeURIComponent(transactionId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': '1'
      },
      body: JSON.stringify({ status: 'canceled' }),
      signal: AbortSignal.timeout(10_000)
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.data?.id !== transactionId ||
      String(payload?.data?.status || '').toLowerCase() !== 'canceled') {
    throw new Error('paddle_transaction_cancel_unconfirmed');
  }
  return { id: transactionId, status: 'canceled' };
}
