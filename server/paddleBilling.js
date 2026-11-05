import { rollbackPooledTransaction } from './withPooledTransaction.js';

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
  const hasSubscriptionIdentity = typeof subscriptionId === 'string' && subscriptionId.length > 0;
  // A non-terminal status without its provider ID is corrupt/unreconciled state,
  // not proof that no subscription exists. Fail closed to avoid a second charge.
  return (hasSubscriptionIdentity || status.length > 0) &&
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

async function markPaddleCheckoutAttemptForReconciliation(client, userId, plan, transactionId, attemptId = null) {
  const validUserId = typeof userId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
  const validAttemptId = typeof attemptId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId);
  const validTransactionId = typeof transactionId === 'string' &&
    /^txn_[A-Za-z0-9]+$/.test(transactionId);
  if (!validUserId ||
      (!validAttemptId && (!['1month', '3months', 'lifetime'].includes(plan) || !validTransactionId))) {
    return 0;
  }
  const safeTransactionId = validTransactionId ? transactionId : null;
  const result = await client.query(
    `UPDATE paddle_checkout_attempts
     SET status = 'reconciliation_required', updated_at = statement_timestamp()
     WHERE user_id = $1
       AND (
         ($4::uuid IS NOT NULL AND attempt_id = $4::uuid)
         OR ($4::uuid IS NULL AND plan = $2 AND transaction_id = $3)
       )
       AND ($3::text IS NULL OR transaction_id IS NULL OR transaction_id = $3)
       AND status IN ('creating', 'pending', 'completed', 'reconciliation_required')`,
    [userId, plan, safeTransactionId, validAttemptId ? attemptId : null]
  );
  return result.rowCount;
}


function parsePaddleMinorAmount(value) {
  const raw = typeof value === 'string'
    ? value
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (!raw || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw) <= 9223372036854775807n ? raw : null;
  } catch {
    return null;
  }
}

function parsePaddleSignedMinorAmount(value) {
  const raw = typeof value === 'string'
    ? value
    : Number.isSafeInteger(value) ? String(value) : null;
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  try {
    const parsed = BigInt(raw);
    const safeLimit = BigInt(Number.MAX_SAFE_INTEGER);
    return parsed >= -safeLimit && parsed <= safeLimit ? raw : null;
  } catch {
    return null;
  }
}

function paddleTransactionAmount(data) {
  // Paddle details.totals.total is the amount after discounts and tax,
  // before credits. Keep it separate from grand_total (net due after credits).
  return data?.details?.totals?.total ?? null;
}

function paddleTransactionFinancialTotals(data) {
  const totals = data?.details?.totals ?? {};
  return {
    amountMinorUnits: parsePaddleSignedMinorAmount(paddleTransactionAmount(data)),
    grandTotalMinorUnits: parsePaddleSignedMinorAmount(totals.grandTotal ?? totals.grand_total),
    creditMinorUnits: parsePaddleSignedMinorAmount(totals.credit),
    balanceMinorUnits: parsePaddleSignedMinorAmount(totals.balance)
  };
}

function paddleCurrencyCode(data) {
  const value = data?.currencyCode ?? data?.currency_code;
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value)
    ? value.toUpperCase() : null;
}

function inferPaddleTransactionPlan(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const priceIds = items.map(item => item?.priceId || item?.price_id || item?.price?.id).filter(Boolean);
  const configuredPlans = [
    [process.env.PADDLE_PRICE_ID_LIFETIME, 'lifetime'],
    [process.env.PADDLE_PRICE_ID_1MONTH, '1month'],
    [process.env.PADDLE_PRICE_ID_3MONTHS, '3months']
  ];
  const matches = configuredPlans
    .filter(([priceId]) => typeof priceId === 'string' && priceIds.includes(priceId))
    .map(([, plan]) => plan);
  return matches.length === 1 ? matches[0] : null;
}

async function isPaddleTransactionOwnerAmbiguous(client, transactionId) {
  if (typeof transactionId !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(transactionId)) return false;
  const result = await client.query(
    `SELECT COUNT(DISTINCT user_id) > 1 AS ambiguous
     FROM (
       SELECT user_id, transaction_id FROM paddle_checkout_attempts
       UNION ALL
       SELECT user_id, transaction_id FROM paddle_checkout_attempt_history
       UNION ALL
       SELECT user_id, transaction_id FROM paddle_transaction_events WHERE user_id IS NOT NULL
     ) AS owners
     WHERE transaction_id = $1`,
    [transactionId]
  );
  return result.rows?.[0]?.ambiguous === true;
}

async function findPaddleTransactionOwner(client, {
  attemptUserId = null, transactionId = null, subscriptionId = null, customerId = null
} = {}) {
  const validAttemptUserId = typeof attemptUserId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptUserId);
  if (typeof transactionId === 'string' && /^txn_[A-Za-z0-9]+$/.test(transactionId)) {
    // Transaction identity is globally unique across current and archived
    // attempts. Never trust the just-claimed attempt owner without checking
    // that an older archived attempt does not already claim this provider ID.
    const attemptOwner = await client.query(
      `SELECT DISTINCT user_id
       FROM (
         SELECT user_id, transaction_id FROM paddle_checkout_attempts
         UNION ALL
         SELECT user_id, transaction_id FROM paddle_checkout_attempt_history
         UNION ALL
         SELECT user_id, transaction_id FROM paddle_transaction_events WHERE user_id IS NOT NULL
       ) AS attempts
       WHERE transaction_id = $1
       ORDER BY user_id
       LIMIT 2`,
      [transactionId]
    );
    if (attemptOwner.rowCount > 1) return null;
    if (attemptOwner.rowCount === 1) {
      const ownerId = attemptOwner.rows?.[0]?.user_id ?? null;
      return validAttemptUserId && ownerId !== attemptUserId ? null : ownerId;
    }
    // A claimed attempt must be visible in the durable ledger. If it is not,
    // fail closed instead of trusting webhook custom_data alone.
    if (validAttemptUserId) return null;
  } else if (validAttemptUserId) {
    return null;
  }
  if (!subscriptionId && !customerId) return null;
  const result = await client.query(
    `SELECT id FROM users
     WHERE ($1::text IS NOT NULL AND paddle_subscription_id = $1)
        OR ($2::text IS NOT NULL AND paddle_customer_id = $2)
     ORDER BY id
     LIMIT 2`,
    [subscriptionId, customerId]
  );
  return result.rowCount === 1 ? (result.rows?.[0]?.id ?? null) : null;
}

async function recordPaddleTransactionEvent(client, {
  eventId, transactionId, userId = null, plan = null, status,
  subscriptionId = null, customerId = null, occurredAt = null,
  amountMinorUnits = null, grandTotalMinorUnits = null,
  creditMinorUnits = null, balanceMinorUnits = null, currencyCode = null
}) {
  const providerTime = typeof occurredAt === 'string' && Number.isFinite(Date.parse(occurredAt))
    ? occurredAt : null;
  await client.query(
    `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, amount_minor_units,
        grand_total_minor_units, credit_minor_units, balance_minor_units, currency_code,
        subscription_id, customer_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, transactionId, userId, plan, status, amountMinorUnits,
      grandTotalMinorUnits, creditMinorUnits, balanceMinorUnits, currencyCode,
      subscriptionId, customerId, providerTime]
  );
}

export async function getPaddleAdjustmentState(client, transactionId) {
  const result = await client.query(
    `WITH latest_per_adjustment AS (
       -- Keep each adjustment/action lifecycle independent. Paddle emits a
       -- separate chargeback_reverse adjustment when it successfully contests
       -- a dispute; it may not emit adjustment.updated for the original
       -- chargeback. Reconcile reversals one-to-one in provider chronology
       -- and require the recovered amount and currency to match; fail closed
       -- while any chargeback remains unmatched or only partially reversed.
       SELECT DISTINCT ON (adjustment_id, action)
         adjustment_id, action, adjustment_type, status, amount_minor_units,
         currency_code, occurred_at, received_at, event_id
       FROM paddle_adjustment_events
       WHERE transaction_id = $1
         -- A refund with no recognized scope is retained for review but must
         -- not supersede a previously verified full/partial adjustment state.
         AND NOT (action = 'refund' AND adjustment_type IS NULL)
       ORDER BY adjustment_id, action, occurred_at DESC,
         CASE status
           WHEN 'pending_approval' THEN 0
           WHEN 'approved' THEN 1
           WHEN 'rejected' THEN 2
           WHEN 'reversed' THEN 3
         END DESC,
         received_at DESC, event_id DESC
     ),
     chargebacks AS (
       SELECT adjustment_id, amount_minor_units, currency_code, occurred_at,
         ROW_NUMBER() OVER (PARTITION BY amount_minor_units, currency_code ORDER BY occurred_at, adjustment_id) AS sequence_number
       FROM latest_per_adjustment
       WHERE action = 'chargeback' AND status IN ('approved', 'reversed')
     ),
     chargeback_reversals AS (
       SELECT adjustment_id, amount_minor_units, currency_code, occurred_at,
         ROW_NUMBER() OVER (PARTITION BY amount_minor_units, currency_code ORDER BY occurred_at, adjustment_id) AS sequence_number
       FROM latest_per_adjustment
       WHERE action = 'chargeback_reverse' AND status = 'approved'
     ),
     chargeback_reconciliation AS (
       SELECT
         (SELECT COUNT(*) FROM chargebacks) AS chargeback_count,
         (SELECT COUNT(*) FROM chargeback_reversals) AS reversal_count,
         NOT EXISTS (
           SELECT 1
           FROM chargebacks AS chargeback
           LEFT JOIN chargeback_reversals AS reversal
             ON reversal.sequence_number = chargeback.sequence_number
            AND chargeback.amount_minor_units IS NOT NULL
            AND reversal.amount_minor_units IS NOT NULL
            AND reversal.amount_minor_units = chargeback.amount_minor_units
            AND chargeback.currency_code IS NOT NULL
            AND reversal.currency_code IS NOT NULL
            AND reversal.currency_code = chargeback.currency_code
           WHERE reversal.adjustment_id IS NULL
              OR reversal.occurred_at <= chargeback.occurred_at
         ) AS all_chargebacks_paired
     )
     SELECT
       EXISTS (
         SELECT 1
         FROM latest_per_adjustment AS latest
         WHERE latest.action = 'refund'
           AND latest.adjustment_type = 'full'
           AND (
             latest.status IN ('approved', 'reversed')
             OR (
               latest.status IN ('pending_approval', 'rejected')
               AND EXISTS (
                 SELECT 1 FROM paddle_adjustment_events AS prior
                 WHERE prior.adjustment_id = latest.adjustment_id
                   AND prior.transaction_id = $1
                   AND prior.action = 'refund'
                   AND prior.adjustment_type = 'full'
                   AND prior.status = 'approved'
                   AND prior.occurred_at <= latest.occurred_at
               )
             )
           )
       ) AS full_refund_active,
       (
         SELECT chargeback_count > 0
           AND NOT (chargeback_count = reversal_count AND all_chargebacks_paired)
         FROM chargeback_reconciliation
       ) AS chargeback_active,
       (
         SELECT chargeback_count > 0
           AND chargeback_count = reversal_count
           AND all_chargebacks_paired
         FROM chargeback_reconciliation
       ) AS chargeback_reversed,
       FALSE AS full_refund_reversed`,
    [transactionId]
  );
  const fullRefundActive = result.rows[0]?.full_refund_active === true;
  const chargebackActive = result.rows[0]?.chargeback_active === true;
  return {
    fullRefundActive,
    chargebackActive,
    chargebackReversed: result.rows[0]?.chargeback_reversed === true,
    fullRefundReversed: result.rows[0]?.full_refund_reversed === true,
    hasAdverseAdjustment: fullRefundActive || chargebackActive,
    revokeReason: fullRefundActive ? 'paddle_full_refund'
      : chargebackActive ? 'paddle_chargeback' : null
  };
}

async function recordPaddleAdjustmentReconciliationCase(client, {
  eventId, adjustmentId, transactionId, reasonCode
}) {
  const providerAdjustmentId = typeof adjustmentId === 'string' &&
    /^adj_[A-Za-z0-9]+$/.test(adjustmentId) ? adjustmentId : null;
  const providerTransactionId = typeof transactionId === 'string' &&
    /^txn_[A-Za-z0-9]+$/.test(transactionId) ? transactionId : null;
  await client.query(
    `INSERT INTO paddle_adjustment_reconciliation_cases
       (event_id, reason_code, provider_transaction_id, provider_adjustment_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, reasonCode, providerTransactionId, providerAdjustmentId]
  );
}

async function resolvePaddleAdjustmentReconciliationCases(client, transactionId, userId, resolutionNote) {
  await client.query(
    `UPDATE paddle_adjustment_reconciliation_cases AS cases
     SET status = 'resolved',
         resolution_note = $3,
         resolution_source = 'automatic_provider_transaction_link',
         resolved_by_ref = NULL,
         resolved_at = statement_timestamp(),
         updated_at = statement_timestamp()
     FROM paddle_adjustment_events AS source
     WHERE cases.event_id = source.event_id
       AND source.transaction_id = $1
       AND cases.status = 'open'
       AND cases.reason_code = 'transaction_owner_unlinked'
       AND (
         SELECT COUNT(DISTINCT (user_id, plan))
         FROM (
           SELECT user_id, transaction_id, plan, status FROM paddle_checkout_attempts
           UNION ALL
           SELECT user_id, transaction_id, plan, status FROM paddle_checkout_attempt_history
           UNION ALL
           SELECT event.user_id, event.transaction_id, event.plan, 'linked'::text AS status
           FROM paddle_transaction_events AS event
           JOIN paddle_webhook_events AS webhook ON webhook.event_id = event.event_id
           JOIN users AS owner ON owner.id = event.user_id
           WHERE event.transaction_id = $1
             AND (
               (event.status = 'completed' AND webhook.event_type = 'transaction.completed')
               OR (
                 event.status = 'paid'
                 AND webhook.event_type = 'subscription.created'
                 AND event.subscription_id IS NOT NULL
                 AND event.customer_id IS NOT NULL
                 AND owner.paddle_subscription_id = event.subscription_id
                 AND owner.paddle_customer_id = event.customer_id
               )
             )
             AND event.user_id IS NOT NULL AND event.plan IS NOT NULL
         ) AS attempts
         WHERE attempts.transaction_id = $1
           AND attempts.status IN ('linked', 'completed')
       ) = 1
       AND EXISTS (
         SELECT 1 FROM paddle_checkout_attempts AS linked_attempt
         WHERE linked_attempt.transaction_id = $1
           AND linked_attempt.user_id = $2
           AND linked_attempt.status IN ('linked', 'completed')
         UNION ALL
         SELECT 1 FROM paddle_checkout_attempt_history AS linked_history
         WHERE linked_history.transaction_id = $1
           AND linked_history.user_id = $2
           AND linked_history.status IN ('linked', 'completed')
         UNION ALL
         SELECT 1
         FROM paddle_transaction_events AS linked_transaction
         JOIN paddle_webhook_events AS webhook ON webhook.event_id = linked_transaction.event_id
         JOIN users AS owner ON owner.id = linked_transaction.user_id
         WHERE linked_transaction.transaction_id = $1
           AND linked_transaction.user_id = $2
           AND linked_transaction.plan IN ('1month', '3months')
           AND (
             (linked_transaction.status = 'completed' AND webhook.event_type = 'transaction.completed')
             OR (
               linked_transaction.status = 'paid'
               AND webhook.event_type = 'subscription.created'
               AND linked_transaction.subscription_id IS NOT NULL
               AND linked_transaction.customer_id IS NOT NULL
               AND owner.paddle_subscription_id = linked_transaction.subscription_id
               AND owner.paddle_customer_id = linked_transaction.customer_id
             )
           )
       )`,
    [transactionId, userId, resolutionNote]
  );
}

async function recordPaddleProviderIdentityConflictCase(client, {
  eventId, transactionId, userId, plan
}) {
  const providerTransactionId = typeof transactionId === 'string' &&
    /^txn_[A-Za-z0-9]+$/.test(transactionId) ? transactionId : null;
  const providerUserRef = typeof userId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
    ? userId : null;
  const providerPlan = ['1month', '3months', 'lifetime'].includes(plan) ? plan : null;
  await client.query(
    `INSERT INTO paddle_adjustment_reconciliation_cases
       (event_id, reason_code, provider_transaction_id, provider_user_ref, provider_plan)
     VALUES ($1, 'provider_identity_conflict', $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, providerTransactionId, providerUserRef, providerPlan]
  );
}

async function processPaddleAdjustment(client, { eventId, occurredAt, data }) {
  const adjustmentId = data.id;
  const transactionId = data.transactionId || data.transaction_id;
  // Serialize valid events for this provider transaction. transaction.completed
  // takes the same lock before it grants lifetime Premium, so an adjustment
  // cannot be committed unseen while the purchase is being linked.
  if (typeof transactionId === 'string' && /^txn_[A-Za-z0-9]+$/.test(transactionId)) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('paddle-transaction:' || $1::text, 0))",
      [transactionId]
    );
  }
  const action = String(data.action || '').toLowerCase();
  const status = String(data.status || '').toLowerCase();
  const validType = data.type === null || data.type === 'full' || data.type === 'partial';
  const type = data.type === 'full' || data.type === 'partial' ? data.type : null;
  // Refunds require an explicit full/partial classification. Preserve a
  // malformed signed event in the ledger, but never infer a refund scope.
  const invalidTypeMetadata = !validType || (action === 'refund' && type === null);
  const validAdjustmentId = typeof adjustmentId === 'string' && /^adj_[A-Za-z0-9]+$/.test(adjustmentId);
  const validTransactionId = typeof transactionId === 'string' && /^txn_[A-Za-z0-9]+$/.test(transactionId);
  const validActions = new Set([
    'credit', 'refund', 'chargeback', 'chargeback_reverse',
    'chargeback_warning', 'chargeback_warning_reverse', 'credit_reverse'
  ]);
  const validStatuses = new Set(['pending_approval', 'approved', 'rejected', 'reversed']);
  if (!validAdjustmentId || !validTransactionId || !validActions.has(action) || !validStatuses.has(status) ||
      !occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
    await recordPaddleAdjustmentReconciliationCase(client, {
      eventId, adjustmentId, transactionId,
      reasonCode: 'invalid_adjustment_payload'
    });
    return { handled: true, reconciliationRequired: true };
  }

  const amountMinorUnits = parsePaddleMinorAmount(data?.totals?.total);
  const currencyCode = paddleCurrencyCode(data);
  const incompleteFinancialMetadata = amountMinorUnits === null || currencyCode === null;

  await client.query(
    `INSERT INTO paddle_adjustment_events
       (event_id, adjustment_id, transaction_id, action, adjustment_type, status,
        amount_minor_units, currency_code, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, adjustmentId, transactionId, action, type, status,
      amountMinorUnits, currencyCode, occurredAt]
  );

  if (invalidTypeMetadata || incompleteFinancialMetadata) {
    // Type metadata does not affect chargeback/credit handling, and amount/
    // currency fields do not affect entitlement state. Preserve signed action
    // semantics while keeping incomplete financial metadata visible for review.
    await recordPaddleAdjustmentReconciliationCase(client, {
      eventId, adjustmentId, transactionId,
      reasonCode: 'invalid_adjustment_payload'
    });
  }

  if (action === 'refund' && type !== null &&
      ['pending_approval', 'approved', 'rejected', 'reversed'].includes(status)) {
    const conflictingFinalState = await client.query(
      `SELECT (
         (
           $4::text = 'reversed'
         )
         OR (
           $4::text IN ('pending_approval', 'approved', 'rejected')
           AND EXISTS (
             SELECT 1
             FROM paddle_adjustment_events AS prior
             WHERE prior.adjustment_id = $1
               AND prior.transaction_id = $2
               AND prior.action = 'refund'
               AND prior.adjustment_type = $3
               AND prior.status IN ('approved', 'rejected')
               AND prior.status <> $4
               AND prior.occurred_at <= $5::timestamptz
           )
         )
       ) AS conflicting_final_state`,
      [adjustmentId, transactionId, type, status, occurredAt]
    );
    if (conflictingFinalState.rows?.[0]?.conflicting_final_state === true) {
      // Paddle describes approval/rejection as mutually exclusive final
      // outcomes. Keep any earlier approval adverse and send contradictory
      // final-state evidence to the moderator queue instead of restoring access.
      await recordPaddleAdjustmentReconciliationCase(client, {
        eventId, adjustmentId, transactionId,
        reasonCode: 'provider_lifecycle_conflict'
      });
    }
  }

  const linked = await client.query(
    `SELECT user_id, plan,
       CASE WHEN bool_or(status = 'linked') THEN 'linked' ELSE 'completed' END AS status
     FROM (
       SELECT user_id, transaction_id, plan, status FROM paddle_checkout_attempts
       UNION ALL
       SELECT user_id, transaction_id, plan, status FROM paddle_checkout_attempt_history
       UNION ALL
       SELECT event.user_id, event.transaction_id, event.plan, 'linked'::text AS status
       FROM paddle_transaction_events AS event
       JOIN paddle_webhook_events AS webhook ON webhook.event_id = event.event_id
       JOIN users AS owner ON owner.id = event.user_id
       WHERE event.transaction_id = $1
         AND event.plan IN ('1month', '3months')
         AND (
           (event.status = 'completed' AND webhook.event_type = 'transaction.completed')
           OR (
             event.status = 'paid'
             AND webhook.event_type = 'subscription.created'
             AND event.subscription_id IS NOT NULL
             AND event.customer_id IS NOT NULL
             AND owner.paddle_subscription_id = event.subscription_id
             AND owner.paddle_customer_id = event.customer_id
           )
         )
         AND event.user_id IS NOT NULL
     ) AS attempts
     WHERE transaction_id = $1 AND status IN ('linked', 'completed')
     GROUP BY user_id, plan
     LIMIT 2`,
    [transactionId]
  );
  if (linked.rowCount !== 1) {
    await recordPaddleAdjustmentReconciliationCase(client, {
      eventId, adjustmentId, transactionId,
      reasonCode: linked.rowCount > 1
        ? 'transaction_owner_ambiguous'
        : 'transaction_owner_unlinked'
    });
    return { handled: true, adjustmentRecorded: true, reconciliationRequired: true };
  }

  // Recurring Vow purchases are recorded for financial history, but lifetime
  // entitlement logic must never be applied to them.
  if (linked.rows[0].plan !== 'lifetime') {
    return {
      handled: true,
      adjustmentRecorded: true,
      entitlementChanged: false,
      premiumRevoked: false
    };
  }
  if (linked.rows[0].status !== 'linked') {
    await recordPaddleAdjustmentReconciliationCase(client, {
      eventId, adjustmentId, transactionId,
      reasonCode: 'transaction_owner_unlinked'
    });
    return { handled: true, adjustmentRecorded: true, reconciliationRequired: true };
  }

  const userId = linked.rows[0].user_id;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('gift-safety-user:' || $1::uuid::text))",
    [userId]
  );
  const userResult = await client.query(
    'SELECT id, status, premium_lifetime FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  const user = userResult.rows[0];
  if (!user || user.status !== 'active') {
    await recordPaddleAdjustmentReconciliationCase(client, {
      eventId, adjustmentId, transactionId,
      reasonCode: 'lifetime_account_inactive'
    });
    return { handled: true, adjustmentRecorded: true, reconciliationRequired: true };
  }

  // Backfill is deliberately limited to accounts that still have the lifetime
  // entitlement. A missing provenance row must never be guessed or re-granted.
  await client.query(
    `INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status)
     SELECT $2, id, 'active' FROM users
     WHERE id = $1 AND premium_lifetime IS TRUE
     ON CONFLICT (transaction_id) DO NOTHING`,
    [userId, transactionId]
  );
  const entitlementResult = await client.query(
    'SELECT status, revoke_reason FROM paddle_lifetime_entitlements WHERE transaction_id = $1 AND user_id = $2 FOR UPDATE',
    [transactionId, userId]
  );
  const entitlement = entitlementResult.rows[0];
  if (!entitlement) {
    await recordPaddleAdjustmentReconciliationCase(client, {
      eventId, adjustmentId, transactionId,
      reasonCode: 'lifetime_entitlement_missing'
    });
    return { handled: true, adjustmentRecorded: true, reconciliationRequired: true };
  }

  const adjustmentState = await getPaddleAdjustmentState(client, transactionId);
  const hasAdverseAdjustment = adjustmentState.hasAdverseAdjustment;
  const reversalMatchesRevocation =
    entitlement.revoke_reason === 'paddle_chargeback' &&
    ['chargeback_reverse', 'chargeback'].includes(action) &&
    ((action === 'chargeback_reverse' && status === 'approved') ||
     (action === 'chargeback' && ['approved', 'reversed'].includes(status))) &&
    adjustmentState.chargebackReversed;

  let nextStatus = entitlement.status;
  let revokeReason = entitlement.revoke_reason;
  if (hasAdverseAdjustment) {
    nextStatus = 'revoked';
    revokeReason = adjustmentState.revokeReason;
  } else if (reversalMatchesRevocation && entitlement.status === 'revoked') {
    nextStatus = 'active';
    revokeReason = null;
  }

  if (nextStatus !== entitlement.status || revokeReason !== entitlement.revoke_reason) {
    await client.query(
      `UPDATE paddle_lifetime_entitlements
       SET status = $3, revoke_reason = $4, updated_at = statement_timestamp()
       WHERE transaction_id = $1 AND user_id = $2`,
      [transactionId, userId, nextStatus, revokeReason]
    );
    // Recompute from all verified lifetime purchases so one refunded purchase
    // cannot revoke a separate still-valid lifetime purchase for the same user.
    await client.query(
      `UPDATE users
       SET premium_lifetime = EXISTS (
         SELECT 1 FROM paddle_lifetime_entitlements
         WHERE user_id = $1 AND status = 'active'
       ), updated_at = statement_timestamp()
       WHERE id = $1 AND status = 'active'`,
      [userId]
    );
  }

  return {
    handled: true,
    adjustmentRecorded: true,
    entitlementChanged: nextStatus !== entitlement.status,
    premiumRevoked: nextStatus === 'revoked'
  };
}

export async function processPaddleEvent(pool, rawEvent) {
  const event = normalizePaddleEvent(rawEvent);
  if (!event) throw new Error('invalid_paddle_event');

  const { eventId, eventType, data, occurredAt } = event;
  const subscriptionLifecycleEvent = ['subscription.created', 'subscription.updated', 'subscription.canceled'].includes(eventType);
  let client = await pool.connect();
  let reconciliationContext = null;
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

    // Keep the deduplication row outside a savepoint so invalid provider
    // payloads and identity conflicts can be acknowledged without endless retries.
    await client.query('SAVEPOINT paddle_event_effects');
    // Lifecycle events need a valid source timestamp and subscription identity
    // for ordering/ownership. Consume malformed signed events without changing
    // entitlement rather than returning 500 forever to the provider.
    if (subscriptionLifecycleEvent &&
        (!occurredAt || !Number.isFinite(Date.parse(occurredAt)) ||
         typeof data.id !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(data.id))) {
      await client.query('COMMIT');
      return { duplicate: false, handled: true };
    }
    const customData = data.customData || data.custom_data || {};
    const rawCustomUserId = typeof customData.userId === 'string' ? customData.userId
      : typeof customData.user_id === 'string' ? customData.user_id : null;
    // Paddle custom_data is external input; avoid passing malformed identifiers into
    // PostgreSQL UUID casts, which would turn a bad metadata value into endless webhook retries.
    const customUserId = rawCustomUserId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCustomUserId)
      ? rawCustomUserId
      : null;
    const hasCamelCustomUserId = Object.prototype.hasOwnProperty.call(customData, 'userId');
    const hasSnakeCustomUserId = Object.prototype.hasOwnProperty.call(customData, 'user_id');
    const customUserIdMetadataConflict =
      ((hasCamelCustomUserId || hasSnakeCustomUserId) && !customUserId) ||
      (hasCamelCustomUserId && hasSnakeCustomUserId && customData.userId !== customData.user_id);
    const rawCheckoutAttemptId = typeof customData.checkoutAttemptId === 'string'
      ? customData.checkoutAttemptId : null;
    const checkoutAttemptId = rawCheckoutAttemptId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCheckoutAttemptId)
      ? rawCheckoutAttemptId : null;
    reconciliationContext = {
      userId: customUserId,
      plan: typeof customData.plan === 'string' ? customData.plan : null,
      attemptId: checkoutAttemptId
    };
    const subscriptionId = typeof data.id === 'string' && eventType.startsWith('subscription.')
      ? data.id
      : typeof data.subscriptionId === 'string' ? data.subscriptionId
        : typeof data.subscription_id === 'string' ? data.subscription_id : null;
    const adjustmentWebhookEvent = eventType === 'adjustment.created' || eventType === 'adjustment.updated';
    // The transaction lock is always acquired before any user lock. A
    // subscription.created event also writes paid transaction evidence, so it
    // must lock its originating transaction here rather than later in the
    // database trigger (which would invert the user -> transaction lock order).
    const paddleTransactionIdForLock = ['transaction.paid', 'transaction.completed', 'transaction.canceled'].includes(eventType)
      ? data.id
      : eventType === 'subscription.created'
        ? (typeof data.transactionId === 'string' ? data.transactionId
          : typeof data.transaction_id === 'string' ? data.transaction_id : null)
        : null;
    if (typeof paddleTransactionIdForLock === 'string' &&
        /^txn_[A-Za-z0-9]+$/.test(paddleTransactionIdForLock)) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('paddle-transaction:' || $1::text, 0))",
        [paddleTransactionIdForLock]
      );
    }
    // Serialize provider identity/entitlement writes with account deletion and
    // safety actions. Deletion holds this same advisory key across external
    // Paddle cancellation, so a late subscription.created event cannot attach
    // a renewing subscription after the account has been deleted.
    let existingSubscriptionOwnerUserId = null;
    if (subscriptionLifecycleEvent && subscriptionId) {
      const existingOwner = await client.query(
        'SELECT id FROM users WHERE paddle_subscription_id = $1 LIMIT 1',
        [subscriptionId]
      );
      existingSubscriptionOwnerUserId = existingOwner.rows[0]?.id || null;
    }
    const subscriptionOwnerMetadataConflict = subscriptionLifecycleEvent && (
      customUserIdMetadataConflict ||
      Boolean(customUserId && existingSubscriptionOwnerUserId &&
        customUserId !== existingSubscriptionOwnerUserId)
    );
    // If provider metadata conflicts with a retained subscription owner, lock
    // the retained owner only for safe adverse lifecycle updates. Never lock or
    // mutate an arbitrary account selected from contradictory custom_data.
    let paddleIdentityUserId = subscriptionOwnerMetadataConflict
      ? existingSubscriptionOwnerUserId
      : customUserId || existingSubscriptionOwnerUserId;
    if (paddleIdentityUserId && !adjustmentWebhookEvent) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('gift-safety-user:' || $1::uuid::text))",
        [paddleIdentityUserId]
      );
      // Match checkout's row-lock order: user first, checkout attempt second.
      // Claiming the attempt before locking users can deadlock against a checkout
      // request that already holds the user row and is waiting on this attempt.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [paddleIdentityUserId]);
      reconciliationContext.userId = paddleIdentityUserId;
    }
    const customerId = typeof data.customerId === 'string' ? data.customerId
      : typeof data.customer_id === 'string' ? data.customer_id
        : (eventType === 'customer.created' || eventType === 'customer.updated') && typeof data.id === 'string' ? data.id : null;
    const ownerCheckTransactionId = ['transaction.completed', 'transaction.canceled'].includes(eventType)
      ? data.id
      : eventType === 'subscription.created'
        ? (typeof data.transactionId === 'string' ? data.transactionId
          : typeof data.transaction_id === 'string' ? data.transaction_id : null)
        : null;
    const ambiguousTransactionOwner = await isPaddleTransactionOwnerAmbiguous(client, ownerCheckTransactionId);
    // Never persist a provider customer identifier that cannot be used by the
    // authenticated portal/cancellation flows. A signed but malformed event is
    // consumed without changing account identity, avoiding endless webhook retries.
    if ((eventType === 'subscription.created' && customerId === null) ||
        (customerId !== null && !/^ctm_[A-Za-z0-9]+$/.test(customerId) && !adjustmentWebhookEvent)) {
      if (['transaction.paid', 'transaction.completed', 'transaction.canceled'].includes(eventType) &&
          typeof data.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(data.id)) {
        await recordPaddleTransactionEvent(client, {
          eventId, transactionId: data.id, userId: null,
          plan: inferPaddleTransactionPlan(data),
          status: eventType === 'transaction.completed' ? 'completed'
            : eventType === 'transaction.paid' ? 'paid' : 'canceled',
          subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
          customerId: null,
          occurredAt,
          ...paddleTransactionFinancialTotals(data),
          currencyCode: paddleCurrencyCode(data)
        });
      }
      const malformedEventTransactionId = ['transaction.paid', 'transaction.completed'].includes(eventType)
        ? data.id
        : eventType === 'subscription.created'
          ? (typeof data.transactionId === 'string' ? data.transactionId
            : typeof data.transaction_id === 'string' ? data.transaction_id : null)
          : null;
      if (customUserIdMetadataConflict || subscriptionOwnerMetadataConflict || ambiguousTransactionOwner) {
        await recordPaddleProviderIdentityConflictCase(client, {
          eventId,
          transactionId: typeof malformedEventTransactionId === 'string' &&
            /^txn_[A-Za-z0-9]+$/.test(malformedEventTransactionId) ? malformedEventTransactionId : null,
          userId: null,
          plan: customData.plan
        });
      }
      if (!customUserIdMetadataConflict && !subscriptionOwnerMetadataConflict && !ambiguousTransactionOwner) {
        await markPaddleCheckoutAttemptForReconciliation(
          client, reconciliationContext.userId, reconciliationContext.plan, malformedEventTransactionId, reconciliationContext.attemptId
        );
      }
      await client.query('COMMIT');
      return { duplicate: false, handled: true };
    }

    if (['subscription.created', 'subscription.updated', 'subscription.canceled'].includes(eventType)) {
      const status = eventType === 'subscription.canceled' ? 'canceled' : String(data.status || '').toLowerCase();
      const rawPeriodEnd = data.currentBillingPeriod?.endsAt ?? data.current_billing_period?.ends_at ?? null;
      // Invalid/missing period ends must never grant Premium, but the lifecycle
      // status should still be persisted (especially cancellations) without a DB cast error.
      const periodEnd = typeof rawPeriodEnd === 'string' && Number.isFinite(Date.parse(rawPeriodEnd))
        ? rawPeriodEnd : null;
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
      const checkoutPlan = priceId === process.env.PADDLE_PRICE_ID_1MONTH ? '1month'
        : priceId === process.env.PADDLE_PRICE_ID_3MONTHS ? '3months' : null;
      const providerPlanMetadataConflict =
        Object.prototype.hasOwnProperty.call(customData, 'plan') && customData.plan !== checkoutPlan;
      const subscriptionIdentityConflict = subscriptionOwnerMetadataConflict ||
        ambiguousTransactionOwner || providerPlanMetadataConflict;
      // A newly-created subscription is the event that grants recurring access.
      // Require a matching durable checkout attempt; custom_data and a known price
      // alone are not proof that this account initiated this Vow checkout.
      // Paddle includes the originating transaction in subscription.created.
      // New checkouts also carry an immutable server attempt ID in custom_data,
      // so a delayed event cannot claim a later attempt while its transaction_id
      // is still NULL. Legacy events without that ID must match a stored
      // transaction_id exactly; they never claim an unbound attempt.
      const subscriptionTransactionId = typeof data.transactionId === 'string'
        ? data.transactionId
        : typeof data.transaction_id === 'string' ? data.transaction_id : null;
      const validSubscriptionTransactionId = typeof subscriptionTransactionId === 'string'
        && /^txn_[A-Za-z0-9]+$/.test(subscriptionTransactionId);
      if (subscriptionIdentityConflict) {
        await recordPaddleProviderIdentityConflictCase(client, {
          eventId,
          transactionId: validSubscriptionTransactionId ? subscriptionTransactionId : null,
          userId: customUserIdMetadataConflict || ambiguousTransactionOwner ? null : customUserId,
          plan: customData.plan
        });
        // A subscription.created event can grant access, so any owner/plan
        // contradiction blocks it completely. For existing subscriptions,
        // still apply non-entitling states (past_due/paused/canceled) to the
        // retained owner, but never extend access from contradictory metadata.
        if (eventType === 'subscription.created' || active) {
          if (eventType === 'subscription.created') {
            if (!subscriptionOwnerMetadataConflict && !ambiguousTransactionOwner) {
              await markPaddleCheckoutAttemptForReconciliation(
                client, customUserId, customData.plan, subscriptionTransactionId, checkoutAttemptId
              );
            }
          }
          await client.query('COMMIT');
          return { duplicate: false, handled: true };
        }
      }
      const subscriptionUpdateUserId = subscriptionIdentityConflict ? null : customUserId;
      const subscriptionUpdateCustomerId = subscriptionIdentityConflict ? null : customerId;
      const subscriptionUpdatePriceId = subscriptionIdentityConflict ? null : priceId;
      let subscriptionAttemptClaim = { rowCount: 0, rows: [] };
      if (eventType === 'subscription.created' && customUserId && !ambiguousTransactionOwner &&
          checkoutPlan && customData.plan === checkoutPlan && validSubscriptionTransactionId) {
        subscriptionAttemptClaim = await client.query(
          `UPDATE paddle_checkout_attempts
           SET transaction_id = $3, status = 'completed', updated_at = NOW()
           WHERE user_id = $1 AND plan = $2
             AND (
               ($4::uuid IS NOT NULL AND attempt_id = $4::uuid)
               OR ($4::uuid IS NULL AND transaction_id = $3)
             )
             AND (transaction_id IS NULL OR transaction_id = $3)
             AND status IN ('creating', 'pending', 'completed', 'reconciliation_required')
           RETURNING user_id`,
          [customUserId, checkoutPlan, subscriptionTransactionId, checkoutAttemptId]
        );
      }
      if (eventType === 'subscription.created' && subscriptionAttemptClaim.rowCount !== 1) {
        // Persist the webhook event id, but do not grant an entitlement when no
        // server-created checkout attempt can be matched. If the originating
        // transaction is valid, mark only that exact/in-flight attempt for review.
        if (!subscriptionOwnerMetadataConflict && !ambiguousTransactionOwner) {
          await markPaddleCheckoutAttemptForReconciliation(
            client, reconciliationContext.userId, customData.plan, subscriptionTransactionId, checkoutAttemptId
          );
        }
        await client.query('COMMIT');
        return { duplicate: false, handled: true };
      }
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
          AND (
            paddle_subscription_updated_at IS NULL
            OR $8::timestamptz > paddle_subscription_updated_at
            -- At equal provider timestamps, cancellation wins. A verified new
            -- subscription.created may replace only a terminal prior subscription.
            OR (
              $8::timestamptz = paddle_subscription_updated_at
              AND ($10::boolean OR ($9::boolean AND lower(paddle_subscription_status) IN ('canceled', 'completed')))
            )
          )
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
          AND (
            ($9::boolean AND (
              paddle_subscription_id IS NULL
              OR (
                paddle_subscription_id = $3
                AND COALESCE(lower(paddle_subscription_status), '') NOT IN ('canceled', 'completed')
              )
              OR (
                paddle_subscription_id IS DISTINCT FROM $3
                AND lower(paddle_subscription_status) IN ('canceled', 'completed')
              )
            ))
            OR (NOT $9::boolean AND paddle_subscription_id = $3)
          )
          AND ($2::text IS NULL OR paddle_customer_id IS NULL OR paddle_customer_id = $2)
          -- A new subscription may replace only a terminal prior subscription, never an active one.
          -- The source timestamp guard above prevents a delayed old lifecycle event from winning.
          -- A delayed or newly delivered subscription event must not revoke or replace lifetime Premium.
          AND premium_lifetime IS NOT TRUE`,
        [subscriptionUpdateUserId, subscriptionUpdateCustomerId, subscriptionId, status, subscriptionUpdatePriceId, active, active ? periodEnd : null, occurredAt, eventType === 'subscription.created', eventType === 'subscription.canceled']
      );
      if (eventType === 'subscription.created' && customUserId && checkoutPlan) {
        if (subscriptionUpdate.rowCount > 0 && validSubscriptionTransactionId) {
          // subscription.created is also authoritative provider evidence for a
          // recurring checkout when it arrives before transaction.completed.
          // Retain the exact originating transaction, owner, plan and subscription.
          await recordPaddleTransactionEvent(client, {
            eventId,
            transactionId: subscriptionTransactionId,
            userId: customUserId,
            plan: checkoutPlan,
            status: 'paid',
            subscriptionId,
            customerId,
            occurredAt,
            ...paddleTransactionFinancialTotals(data),
            currencyCode: paddleCurrencyCode(data)
          });
        }
        await client.query(
          `UPDATE paddle_checkout_attempts
           SET status = $3, updated_at = NOW()
           WHERE user_id = $1 AND plan = $2
             AND attempt_id IS NOT DISTINCT FROM $4::uuid
             AND transaction_id = $5 AND status = 'completed'`,
          [customUserId, checkoutPlan, subscriptionUpdate.rowCount > 0 ? 'linked' : 'reconciliation_required',
            checkoutAttemptId, subscriptionTransactionId]
        );
      }
    } else if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
      const adjustmentResult = await processPaddleAdjustment(client, { eventId, occurredAt, data });
      await client.query('COMMIT');
      return { duplicate: false, ...adjustmentResult };
    } else if (eventType === 'transaction.paid') {
      // Paddle emits transaction.paid when payment is captured, before internal
      // transaction processing completes. Retain the captured state but never
      // grant access or finalize a checkout from this event alone.
      if (typeof data.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(data.id)) {
        const transactionPlan = inferPaddleTransactionPlan(data);
        let transactionOwnerUserId = await findPaddleTransactionOwner(client, {
          transactionId: data.id,
          subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
          customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null
        });
        // A retained transaction link must not override contradictory signed
        // checkout metadata. Preserve the provider event without attributing it
        // to the old account; the conflict remains visible for reconciliation.
        const providerOwnerConflict = customUserIdMetadataConflict || ambiguousTransactionOwner ||
          Boolean(customUserId && transactionOwnerUserId && customUserId !== transactionOwnerUserId);
        const providerPlanConflict = Object.prototype.hasOwnProperty.call(customData, 'plan') &&
          customData.plan !== transactionPlan;
        if (providerOwnerConflict || providerPlanConflict) {
          // transaction.paid is only a capture snapshot. Defer opening the
          // durable ownership-conflict case until transaction.completed, whose
          // final provider evidence can be reconciled without leaving a
          // permanently unresolvable case for an intermediate event.
          transactionOwnerUserId = null;
        }
        await recordPaddleTransactionEvent(client, {
          eventId,
          transactionId: data.id,
          userId: transactionOwnerUserId,
          plan: transactionPlan,
          status: 'paid',
          subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
          customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null,
          occurredAt,
          ...paddleTransactionFinancialTotals(data),
          currencyCode: paddleCurrencyCode(data)
        });
      }
    } else if (eventType === 'transaction.completed') {
      // Provider payloads are external input even after signature verification.
      // Reject malformed identifiers before they reach database CHECK constraints,
      // otherwise one bad event can retry forever and poison webhook delivery.
      if (typeof data.id !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(data.id) ||
          (subscriptionId !== null && !/^sub_[A-Za-z0-9]+$/.test(subscriptionId))) {
        if (typeof data.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(data.id)) {
          await recordPaddleTransactionEvent(client, {
            eventId, transactionId: data.id, userId: null,
            plan: inferPaddleTransactionPlan(data), status: 'completed',
            subscriptionId: null,
            customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null,
            occurredAt,
            ...paddleTransactionFinancialTotals(data),
            currencyCode: paddleCurrencyCode(data)
          });
        }
        await markPaddleCheckoutAttemptForReconciliation(
          client, reconciliationContext.userId, reconciliationContext.plan,
          typeof data.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(data.id) ? data.id : null,
          reconciliationContext.attemptId
        );
        await client.query('COMMIT');
        return { duplicate: false, handled: true };
      }
      // A verified completed transaction can grant the one-time lifetime plan,
      // but only when its server-configured Paddle price matches the expected price.
      const transactionItems = Array.isArray(data.items) ? data.items : [];
      const lifetimePriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
      const includesLifetimePrice = Boolean(lifetimePriceId) && transactionItems.some(item =>
        (item?.priceId || item?.price_id || item?.price?.id) === lifetimePriceId
      );
      const expectedRecurringPriceId = customData.plan === '1month'
        ? process.env.PADDLE_PRICE_ID_1MONTH
        : customData.plan === '3months' ? process.env.PADDLE_PRICE_ID_3MONTHS : null;
      const includesRecurringPrice = Boolean(expectedRecurringPriceId) && transactionItems.some(item =>
        (item?.priceId || item?.price_id || item?.price?.id) === expectedRecurringPriceId
      );
      const transactionPlan = inferPaddleTransactionPlan(data);
      // A valid Paddle signature and matching price are not enough to grant an
      // entitlement: bind the provider transaction to this account's durable,
      // server-created checkout attempt first. Also accept a webhook that races
      // the checkout HTTP response while the attempt is still in "creating".
      const transactionPlanMatches =
        (customData.plan === 'lifetime' && includesLifetimePrice && transactionPlan === 'lifetime') ||
        (customData.plan === '1month' && includesRecurringPrice && transactionPlan === '1month') ||
        (customData.plan === '3months' && includesRecurringPrice && transactionPlan === '3months');
      // Contradictory owner aliases are ambiguous identity evidence. Do not
      // claim even an otherwise matching checkout attempt: downstream entitlement
      // writes are intentionally gated by this exact claim result.
      const attemptClaim = !customUserIdMetadataConflict && !ambiguousTransactionOwner &&
        transactionPlanMatches && customUserId && data.id
        ? await client.query(
          `UPDATE paddle_checkout_attempts
           SET transaction_id = $1, status = 'completed', updated_at = NOW()
           WHERE user_id = $2 AND plan = $3
             AND (
               ($4::uuid IS NOT NULL AND attempt_id = $4::uuid)
               OR ($4::uuid IS NULL AND transaction_id = $1)
             )
             AND (transaction_id IS NULL OR transaction_id = $1)
             AND status IN ('creating', 'pending', 'completed', 'reconciliation_required')
           RETURNING user_id`,
          [data.id, customUserId, customData.plan, checkoutAttemptId]
        )
        : { rowCount: 0, rows: [] };
      const ownsCheckoutAttempt = attemptClaim.rowCount === 1;
      let transactionOwnerUserId = await findPaddleTransactionOwner(client, {
        attemptUserId: ownsCheckoutAttempt ? customUserId : null,
        transactionId: data.id,
        subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
        customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null
      });
      // Existing transaction evidence may identify an old account even when
      // this webhook's signed checkout metadata names another account. Never
      // let the old link win over contradictory provider context or plan.
      const providerOwnerConflict = customUserIdMetadataConflict || ambiguousTransactionOwner ||
        Boolean(customUserId && transactionOwnerUserId && customUserId !== transactionOwnerUserId);
      const providerPlanConflict = Object.prototype.hasOwnProperty.call(customData, 'plan') &&
        customData.plan !== transactionPlan;
      if (providerOwnerConflict || providerPlanConflict) {
        await recordPaddleProviderIdentityConflictCase(client, {
          eventId, transactionId: data.id,
          userId: customUserIdMetadataConflict || ambiguousTransactionOwner ? null : customUserId,
          plan: customData.plan
        });
        transactionOwnerUserId = null;
      }
      // Migration 183 locks users before paddle_transaction_events. A lifetime
      // or recurring completion writes the transaction ledger and then updates
      // users, so acquire the compatible users table lock first to preserve
      // that same order during an online migration.
      await client.query('LOCK TABLE users IN ROW EXCLUSIVE MODE');
      await recordPaddleTransactionEvent(client, {
        eventId,
        transactionId: data.id,
        userId: transactionOwnerUserId,
        plan: transactionPlan,
        status: 'completed',
        subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
        customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null,
        occurredAt,
        ...paddleTransactionFinancialTotals(data),
        currencyCode: paddleCurrencyCode(data)
      });
      if (transactionOwnerUserId && ['1month', '3months'].includes(transactionPlan)) {
        // A recurring renewal can arrive after an adjustment webhook but does
        // not have a checkout-attempt row. The immutable transaction ledger is
        // sufficient to resolve that non-lifetime reconciliation case.
        await resolvePaddleAdjustmentReconciliationCases(
          client, data.id, transactionOwnerUserId,
          'recurring_transaction_linked_to_vow_subscription'
        );
      }
      if (!ownsCheckoutAttempt && !providerOwnerConflict &&
          typeof data.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(data.id)) {
        // A completed transaction that cannot be tied to the exact server
        // attempt (including a plan/price mismatch) must remain visible for
        // manual reconciliation rather than silently leaving a pending lock.
        await markPaddleCheckoutAttemptForReconciliation(
          client, reconciliationContext.userId, customData.plan, data.id, checkoutAttemptId
        );
      }

      let entitlementLinked = false;
      if (ownsCheckoutAttempt && customData.plan === 'lifetime' && includesLifetimePrice) {
        const lifetimeUpdate = await client.query(
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
        entitlementLinked = lifetimeUpdate.rowCount > 0;
        if (entitlementLinked) {
          const lifetimeSource = await client.query(
            `INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status)
             VALUES ($1, $2, 'active')
             ON CONFLICT (transaction_id) DO UPDATE
             SET updated_at = paddle_lifetime_entitlements.updated_at
             WHERE paddle_lifetime_entitlements.user_id = EXCLUDED.user_id
               AND paddle_lifetime_entitlements.status = 'active'
             RETURNING transaction_id`,
            [data.id, customUserId]
          );
          if (lifetimeSource.rowCount !== 1) {
            entitlementLinked = false;
            await client.query(
              `UPDATE users SET premium_lifetime = EXISTS (
                 SELECT 1 FROM paddle_lifetime_entitlements
                 WHERE user_id = $1 AND status = 'active'
               ), updated_at = NOW()
               WHERE id = $1 AND status = 'active'`,
              [customUserId]
            );
          } else {
            // An adjustment can arrive before transaction.completed. Reconcile
            // the append-only event ledger before exposing the newly linked plan.
            const priorAdjustmentState = await getPaddleAdjustmentState(client, data.id);
            if (priorAdjustmentState.hasAdverseAdjustment) {
              await client.query(
                `UPDATE paddle_lifetime_entitlements
                 SET status = 'revoked', revoke_reason = $2, updated_at = statement_timestamp()
                 WHERE transaction_id = $1 AND user_id = $3 AND status = 'active'`,
                [data.id, priorAdjustmentState.revokeReason, customUserId]
              );
              await client.query(
                `UPDATE users
                 SET premium_lifetime = EXISTS (
                   SELECT 1 FROM paddle_lifetime_entitlements
                   WHERE user_id = $1 AND status = 'active'
                 ), updated_at = statement_timestamp()
                 WHERE id = $1 AND status = 'active'`,
                [customUserId]
              );
            }
          }
        }
      } else if (ownsCheckoutAttempt && includesRecurringPrice) {
        // Recurring subscriptions are provisioned only by verified subscription
        // lifecycle events, never by the checkout redirect or transaction alone.
        await client.query(
          `UPDATE users SET
            paddle_customer_id = COALESCE($2, paddle_customer_id),
            paddle_subscription_id = COALESCE($3, paddle_subscription_id),
            updated_at = NOW()
          WHERE id = $1::uuid AND users.status = 'active'
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

      if (ownsCheckoutAttempt) {
        const nextCheckoutStatus = customData.plan === 'lifetime'
          ? (entitlementLinked ? 'linked' : 'reconciliation_required')
          : (includesRecurringPrice ? 'completed' : 'reconciliation_required');
        await client.query(
          `UPDATE paddle_checkout_attempts SET status = $2, updated_at = NOW()
           WHERE transaction_id = $1 AND user_id = $3
             AND attempt_id IS NOT DISTINCT FROM $4::uuid
             AND status = 'completed'`,
          [data.id, nextCheckoutStatus, customUserId, checkoutAttemptId]
        );
        if (['linked', 'completed'].includes(nextCheckoutStatus)) {
          await resolvePaddleAdjustmentReconciliationCases(
            client, data.id, customUserId, 'transaction_completed_linked_to_vow_checkout'
          );
        }
      }
    } else if (eventType === 'transaction.canceled') {
      if (typeof data.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(data.id)) {
        // The cancellation webhook can arrive after Paddle creates the
        // transaction but before the checkout HTTP response attaches its ID
        // to the durable attempt. Bind by the immutable attempt metadata in
        // that race; otherwise the webhook would be consumed while the row is
        // still "creating", and the HTTP response could later resurrect it
        // as pending using its stale draft/ready response.
        const canceledTransactionPlan = inferPaddleTransactionPlan(data);
        const canceledPlanConflict = Object.prototype.hasOwnProperty.call(customData, 'plan') &&
          customData.plan !== canceledTransactionPlan;
        // Resolve retained ownership before touching a checkout attempt. A
        // contradictory custom_data owner must not cancel another account's
        // attempt merely because its attempt ID was supplied in the payload.
        let transactionOwnerUserId = await findPaddleTransactionOwner(client, {
          transactionId: data.id,
          subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
          customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null
        });
        const canceledOwnerConflict = customUserIdMetadataConflict || ambiguousTransactionOwner || canceledPlanConflict ||
          Boolean(customUserId && transactionOwnerUserId && customUserId !== transactionOwnerUserId);
        const canceledAttempt = canceledOwnerConflict
          ? { rows: [] }
          : await client.query(
            `UPDATE paddle_checkout_attempts
             SET transaction_id = COALESCE(transaction_id, $1),
                 status = 'canceled', updated_at = NOW()
             WHERE (
               ($2::uuid IS NOT NULL AND user_id = $2::uuid
                 AND attempt_id = $3::uuid AND plan = $4)
               OR ($3::uuid IS NULL AND transaction_id = $1)
             )
               AND (transaction_id IS NULL OR transaction_id = $1)
               AND status IN ('creating', 'pending', 'reconciliation_required')
             RETURNING user_id, plan`,
            [data.id, reconciliationContext?.userId || null,
              reconciliationContext?.attemptId || null, reconciliationContext?.plan || null]
          );
        const canceledAttemptRow = canceledAttempt.rows?.[0] ?? null;
        if (!transactionOwnerUserId && canceledAttemptRow?.user_id) {
          transactionOwnerUserId = canceledAttemptRow.user_id;
        }
        if (canceledOwnerConflict) {
          await recordPaddleProviderIdentityConflictCase(client, {
            eventId,
            transactionId: data.id,
            userId: customUserIdMetadataConflict || ambiguousTransactionOwner ? null : customUserId,
            plan: customData.plan
          });
          transactionOwnerUserId = null;
        }
        await recordPaddleTransactionEvent(client, {
          eventId,
          transactionId: data.id,
          userId: transactionOwnerUserId,
          plan: canceledAttemptRow?.plan || canceledTransactionPlan,
          status: 'canceled',
          subscriptionId: subscriptionId && /^sub_[A-Za-z0-9]+$/.test(subscriptionId) ? subscriptionId : null,
          customerId: customerId && /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : null,
          occurredAt,
          ...paddleTransactionFinancialTotals(data),
          currencyCode: paddleCurrencyCode(data)
        });
      }
    } else if (eventType === 'customer.created' || eventType === 'customer.updated') {
      const customerEmail = data.email;
      if (customUserIdMetadataConflict) {
        // Customer lifecycle events can bind an account identity too. Do not
        // choose one of two contradictory custom_data owner aliases.
        await recordPaddleProviderIdentityConflictCase(client, {
          eventId,
          transactionId: null,
          userId: null,
          plan: customData.plan
        });
      } else if (customUserId && customerId && typeof customerEmail === 'string') {
        const customerIdentityUpdate = await client.query(
          `UPDATE users SET paddle_customer_id = COALESCE($2, paddle_customer_id), updated_at = NOW()
           WHERE id = $1::uuid AND users.status = 'active' AND lower(email) = lower($3)
             AND (paddle_customer_id IS NULL OR paddle_customer_id = $2)
             AND NOT EXISTS (
               SELECT 1 FROM users AS other_user
               WHERE other_user.paddle_customer_id = $2 AND other_user.id <> users.id
             )
           RETURNING id`,
          [customUserId, customerId, customerEmail]
        );
        if (customerIdentityUpdate.rowCount !== 1) {
          const identityConflict = await client.query(
            `SELECT
               EXISTS (
                 SELECT 1 FROM users AS other_user
                 WHERE other_user.paddle_customer_id = $1 AND other_user.id <> $2::uuid
               ) AS customer_owned_by_other,
               EXISTS (
                 SELECT 1 FROM users AS owner
                 WHERE owner.id = $2::uuid
                   AND owner.paddle_customer_id IS NOT NULL
                   AND owner.paddle_customer_id <> $1
               ) AS account_customer_mismatch`,
            [customerId, customUserId]
          );
          if (identityConflict.rows?.[0]?.customer_owned_by_other === true ||
              identityConflict.rows?.[0]?.account_customer_mismatch === true) {
            const conflict = new Error('Paddle customer identity conflicts with retained Vow account ownership');
            conflict.code = '23505';
            throw conflict;
          }
        }
      }
    }

    await client.query('COMMIT');
    return { duplicate: false, handled: ['subscription.created', 'subscription.updated', 'subscription.canceled', 'transaction.paid', 'transaction.completed', 'transaction.canceled', 'adjustment.created', 'adjustment.updated', 'customer.created', 'customer.updated'].includes(eventType) };
  } catch (error) {
    if (error?.code === '23505') {
      // A unique identity collision is a security conflict, not a transient
      // provider failure. Roll back only this event's effects, preserve its
      // dedupe row, and mark the matching checkout attempt for manual review.
      try {
        await client.query('ROLLBACK TO SAVEPOINT paddle_event_effects');
        // Reconcile only the checkout attempt tied to this provider transaction.
        // A subscription.updated/canceled identity conflict must never downgrade
        // unrelated or already-linked/canceled purchases for the same account.
        const reconciliationTransactionId = ['transaction.paid', 'transaction.completed', 'transaction.canceled'].includes(eventType)
          ? data.id
          : ['subscription.created', 'adjustment.created', 'adjustment.updated'].includes(eventType)
            ? (typeof data.transactionId === 'string' ? data.transactionId
              : typeof data.transaction_id === 'string' ? data.transaction_id : null)
            : null;
        const providerIdentityConflict = [
          'transaction.paid', 'transaction.completed', 'transaction.canceled',
          'subscription.created', 'subscription.updated', 'subscription.canceled',
          'customer.created', 'customer.updated',
          'adjustment.created', 'adjustment.updated'
        ].includes(eventType);
        if (providerIdentityConflict) {
          const reasonCode = String(error?.message || '').includes('completed/canceled state')
            ? 'provider_lifecycle_conflict'
            : 'provider_identity_conflict';
          const providerTransactionId = typeof reconciliationTransactionId === 'string' &&
            /^txn_[A-Za-z0-9]+$/.test(reconciliationTransactionId)
            ? reconciliationTransactionId : null;
          const providerAdjustmentId = eventType.startsWith('adjustment.') &&
            typeof data.id === 'string' && /^adj_[A-Za-z0-9]+$/.test(data.id)
            ? data.id : null;
          const providerUserRef = typeof reconciliationContext?.userId === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reconciliationContext.userId)
            ? reconciliationContext.userId : null;
          const providerPlan = ['1month', '3months', 'lifetime'].includes(reconciliationContext?.plan)
            ? reconciliationContext.plan : null;
          await client.query(
            `INSERT INTO paddle_adjustment_reconciliation_cases
               (event_id, reason_code, provider_transaction_id, provider_adjustment_id,
                provider_user_ref, provider_plan)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (event_id) DO NOTHING`,
            [eventId, reasonCode, providerTransactionId, providerAdjustmentId, providerUserRef, providerPlan]
          );
        }
        await markPaddleCheckoutAttemptForReconciliation(
          client, reconciliationContext?.userId, reconciliationContext?.plan, reconciliationTransactionId, reconciliationContext?.attemptId
        );
        await client.query('COMMIT');
        return { duplicate: false, handled: true, reconciliationRequired: true };
      } catch (reconciliationError) {
        // A failed savepoint rollback or reconciliation write must not leave the
        // dedupe row/transaction open in a pooled connection.
        if (client && !await rollbackPooledTransaction(client)) client = null;
        throw reconciliationError;
      }
    }
    if (client && !await rollbackPooledTransaction(client)) client = null;
    throw error;
  } finally {
    client?.release();
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
    if (parsed.protocol !== 'https:' ||
        parsed.hostname !== 'sandbox-customer-portal.paddle.com' ||
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

  // Verify provider ownership before issuing the irreversible cancellation.
  // Local IDs can be stale or corrupted; the response check after POST is too late
  // to prevent canceling another account's subscription.
  const lookupResponse = await fetchImpl(
    `https://sandbox-api.paddle.com/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Paddle-Version': '1' },
      signal: AbortSignal.timeout(10_000)
    }
  );
  const lookupPayload = await lookupResponse.json().catch(() => null);
  const lookupData = lookupPayload?.data;
  if (!lookupResponse.ok || lookupData?.id !== subscriptionId ||
      lookupData?.customer_id !== customerId) {
    throw new Error('paddle_subscription_ownership_unconfirmed');
  }
  const providerStatus = String(lookupData.status || '').toLowerCase();
  if (providerStatus === 'canceled') {
    return {
      subscriptionId,
      status: 'canceled',
      customerId,
      updatedAt: typeof lookupData.updated_at === 'string' && Number.isFinite(Date.parse(lookupData.updated_at))
        ? lookupData.updated_at : null
    };
  }
  if (!['active', 'trialing', 'past_due', 'paused'].includes(providerStatus)) {
    throw new Error('paddle_subscription_status_unrecognized');
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
  return {
    subscriptionId,
    status: 'canceled',
    customerId,
    updatedAt: typeof payload?.data?.updated_at === 'string' && Number.isFinite(Date.parse(payload.data.updated_at))
      ? payload.data.updated_at : null
  };
}



/** Persist a provider-confirmed cancellation when checkout creation lost its race with account deactivation. */
export async function markPaddleCheckoutAttemptCanceled(client, { userId, attemptId, transactionId } = {}) {
  const validUuid = value => typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!validUuid(userId) || !validUuid(attemptId) || !isValidPaddleTransactionId(transactionId)) {
    throw new Error('invalid_paddle_checkout_cancellation_identity');
  }
  const result = await client.query(
    `UPDATE paddle_checkout_attempts
     SET transaction_id = COALESCE(transaction_id, $3),
         status = 'canceled', updated_at = NOW()
     WHERE user_id = $1::uuid AND attempt_id = $2::uuid
       AND status = 'creating'
       AND (transaction_id IS NULL OR transaction_id = $3)`,
    [userId, attemptId, transactionId]
  );
  return result.rowCount;
}

function isValidPaddleTransactionId(value) {
  return typeof value === 'string' && /^txn_[A-Za-z0-9]+$/.test(value);
}

async function fetchPaddleTransaction({ apiKey, transactionId, expectedUserId, expectedPlan, expectedAttemptId = null, fetchImpl }) {
  if (typeof apiKey !== 'string' || !apiKey || !isValidPaddleTransactionId(transactionId) ||
      typeof expectedUserId !== 'string' || !expectedUserId ||
      !['1month', '3months', 'lifetime'].includes(expectedPlan) ||
      (expectedAttemptId !== null && (typeof expectedAttemptId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedAttemptId))) ||
      typeof fetchImpl !== 'function') {
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
      data?.custom_data?.plan !== expectedPlan ||
      (expectedAttemptId !== null && data?.custom_data?.checkoutAttemptId !== expectedAttemptId)) {
    throw new Error('paddle_transaction_ownership_unconfirmed');
  }
  return {
    id: transactionId,
    status: String(data.status || '').toLowerCase(),
    origin: String(data.origin || '').toLowerCase(),
    subscriptionId: typeof data.subscription_id === 'string' ? data.subscription_id : null
  };
}

/** Read provider state before reusing or canceling a previously-created checkout transaction. */
export async function getPaddleCheckoutTransaction({
  apiKey,
  environment = 'sandbox',
  transactionId,
  expectedUserId,
  expectedPlan,
  expectedAttemptId = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (environment !== 'sandbox') throw new Error('paddle_transaction_lookup_not_configured');
  return fetchPaddleTransaction({ apiKey, transactionId, expectedUserId, expectedPlan, expectedAttemptId, fetchImpl });
}

/** Cancel only an unpaid draft/ready transaction that is proven to belong to this user and plan. */
export async function cancelPaddleCheckoutTransaction({
  apiKey,
  environment = 'sandbox',
  transactionId,
  expectedUserId,
  expectedPlan,
  expectedAttemptId = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (environment !== 'sandbox') throw new Error('paddle_transaction_cancel_not_configured');
  const transaction = await fetchPaddleTransaction({
    apiKey, transactionId, expectedUserId, expectedPlan, expectedAttemptId, fetchImpl
  });
  if (transaction.status === 'canceled') return transaction;
  if (!['draft', 'ready'].includes(transaction.status)) return transaction;
  if (transaction.subscriptionId || transaction.origin.startsWith('subscription_')) {
    return { ...transaction, status: 'subscription_transaction' };
  }

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
