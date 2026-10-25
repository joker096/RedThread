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
    const customUserId = typeof customData.userId === 'string' ? customData.userId
      : typeof customData.user_id === 'string' ? customData.user_id : null;
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
      const active = isPaddleSubscriptionEntitled(status, periodEnd);
      await client.query(
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
          AND (paddle_subscription_updated_at IS NULL OR $8::timestamptz >= paddle_subscription_updated_at)
          -- Never let custom_data reassign a subscription or customer already owned by another account.
          AND ($3::text IS NULL OR NOT EXISTS (
            SELECT 1 FROM users AS other
            WHERE other.paddle_subscription_id = $3 AND other.id <> users.id
          ))
          AND ($2::text IS NULL OR NOT EXISTS (
            SELECT 1 FROM users AS other
            WHERE other.paddle_customer_id = $2 AND other.id <> users.id
          ))`,
        [customUserId, customerId, subscriptionId, status, priceId, active, active ? periodEnd : null, occurredAt]
      );
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
          WHERE id = $1::uuid`,
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
          WHERE id = COALESCE($1::uuid, (SELECT id FROM users WHERE paddle_subscription_id = $3 LIMIT 1))`,
          [customUserId, customerId, subscriptionId]
        );
      }
    } else if (eventType === 'customer.created' || eventType === 'customer.updated') {
      const customerEmail = data.email;
      if (customUserId && customerId && typeof customerEmail === 'string') {
        await client.query(
          'UPDATE users SET paddle_customer_id = COALESCE($2, paddle_customer_id), updated_at = NOW() WHERE id = $1::uuid AND lower(email) = lower($3)',
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
