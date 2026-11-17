import { randomUUID } from 'node:crypto';

const TERMINAL_PAYMENT_STATES = new Set(['voided', 'failed', 'refunded']);

export function validateGiftProviderOutcome(outcome, identity) {
  if (!outcome || !TERMINAL_PAYMENT_STATES.has(outcome.status)) {
    throw Object.assign(new Error('provider_outcome_not_terminal'), { code: 'provider_outcome_not_terminal' });
  }
  if (outcome.providerKey !== identity.provider_key
      || outcome.providerReference !== identity.provider_reference
      || String(outcome.amountMinorUnits) !== String(identity.amount_minor_units)
      || outcome.currency !== identity.currency) {
    throw Object.assign(new Error('provider_identity_or_amount_mismatch'), { code: 'provider_identity_or_amount_mismatch' });
  }
  return outcome.status;
}

export async function processOneGiftPaymentReconciliation({
  pool,
  providerAdapter,
  workerId = `gift-reconcile-${randomUUID()}`,
  leaseSeconds = 90,
  maxAttempts = 8
}) {
  if (!pool?.connect) throw new TypeError('database_pool_required');
  if (!providerAdapter || typeof providerAdapter.reconcile !== 'function') {
    throw Object.assign(new Error('gift_payment_provider_adapter_not_configured'), {
      code: 'gift_payment_provider_adapter_not_configured'
    });
  }

  const claim = await pool.query(
    'SELECT * FROM claim_gift_payment_reconciliation_task($1, $2, $3)',
    [workerId, leaseSeconds, maxAttempts]
  );
  const task = claim.rows[0];
  if (!task) return { claimed: false };

  const identityResult = await pool.query(
    `SELECT identity.*, orders.payment_status, orders.status AS order_status
       FROM gift_payment_attempt_identity AS identity
       JOIN gift_delivery_orders AS orders ON orders.id = identity.order_id
      WHERE identity.order_id = $1
      ORDER BY identity.created_at DESC
      LIMIT 1`,
    [task.order_id]
  );
  const identity = identityResult.rows[0];
  if (!identity?.provider_reference) {
    await releaseGiftTask(pool, task, 'provider_identity_missing', true);
    return { claimed: true, completed: false, code: 'provider_identity_missing' };
  }

  let outcome;
  try {
    outcome = await providerAdapter.reconcile({
      providerKey: identity.provider_key,
      providerReference: identity.provider_reference,
      idempotencyKey: identity.idempotency_key
    });
    const terminalStatus = validateGiftProviderOutcome(outcome, identity);
    if (terminalStatus === 'refunded' && identity.payment_status !== 'refund_pending'
        && identity.payment_status !== 'refunded') {
      throw Object.assign(new Error('unexpected_refund_state'), { code: 'unexpected_refund_state' });
    }
    if (terminalStatus !== 'refunded'
        && !['authorization_pending', 'authorized', 'captured', 'refund_pending'].includes(identity.payment_status)) {
      throw Object.assign(new Error('unexpected_payment_state'), { code: 'unexpected_payment_state' });
    }
    await commitVerifiedOutcome(pool, task, identity, terminalStatus);
    return { claimed: true, completed: true, status: terminalStatus };
  } catch (error) {
    const code = /^[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'provider_reconciliation_uncertain';
    await releaseGiftTask(pool, task, code, false);
    return { claimed: true, completed: false, code };
  }
}

async function commitVerifiedOutcome(pool, task, identity, status) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderStatus = status === 'refunded' ? 'refunded' : identity.order_status;
    const orderUpdate = await client.query(
      `UPDATE gift_delivery_orders
          SET payment_status = $2, status = CASE WHEN $2 = 'refunded' THEN 'refunded' ELSE status END,
              updated_at = statement_timestamp()
        WHERE id = $1 AND payment_status = $3`,
      [task.order_id, status, identity.payment_status]
    );
    if (orderUpdate.rowCount !== 1) throw Object.assign(new Error('gift_order_payment_state_changed'), { code: 'gift_order_payment_state_changed' });

    const eventType = status === 'refunded' ? 'refunded' : status === 'voided' ? 'payment_voided' : 'payment_failed';
    await client.query(
      `INSERT INTO gift_delivery_order_events
         (order_id, actor_type, event_type, from_status, to_status, metadata)
       VALUES ($1, 'payment_service', $2, $3, $4, $5::jsonb)`,
      [task.order_id, eventType, identity.payment_status, status, JSON.stringify({
        reconciliationTaskId: String(task.id),
        fromPaymentStatus: identity.payment_status,
        toPaymentStatus: status,
        provider: identity.provider_key,
        providerReference: identity.provider_reference
      })]
    );

    const finished = await client.query(
      `UPDATE gift_payment_reconciliation_tasks
          SET status = 'completed', lease_token = NULL, lease_owner = NULL,
              claimed_at = NULL, lease_expires_at = NULL
        WHERE id = $1 AND status = 'in_progress'
          AND lease_token = $2 AND lease_generation = $3
          AND lease_expires_at > statement_timestamp()`,
      [task.id, task.lease_token, task.lease_generation]
    );
    if (finished.rowCount !== 1) throw Object.assign(new Error('gift_reconciliation_lease_lost'), { code: 'gift_reconciliation_lease_lost' });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function releaseGiftTask(pool, task, errorCode, deadLetter) {
  const result = await pool.query(
    `UPDATE gift_payment_reconciliation_tasks
        SET status = 'failed', last_error_code = $4,
            next_attempt_at = statement_timestamp() + INTERVAL '5 minutes',
            dead_lettered_at = CASE WHEN $5 THEN statement_timestamp() ELSE dead_lettered_at END,
            lease_token = NULL, lease_owner = NULL, claimed_at = NULL, lease_expires_at = NULL
      WHERE id = $1 AND status = 'in_progress'
        AND lease_token = $2 AND lease_generation = $3
        AND lease_expires_at > statement_timestamp()`,
    [task.id, task.lease_token, task.lease_generation, errorCode, deadLetter]
  );
  return result.rowCount === 1;
}

// Deliberately no implicit provider selection or network client. A deployment
// must inject a reviewed sandbox adapter from its own composition root.
