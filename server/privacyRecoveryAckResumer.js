import { randomUUID } from 'node:crypto';
import { deliverPrivacyRecoveryLedgerPayload } from './privacyRecoveryLedger.js';
import { withPooledTransaction } from './withPooledTransaction.js';

const SAFE_LEDGER_ERRORS = new Set([
  'privacy_recovery_ledger_unavailable',
  'privacy_recovery_ledger_rejected_event',
  'privacy_recovery_ledger_invalid_acknowledgement',
  'privacy_recovery_ledger_not_configured',
  'privacy_recovery_ledger_invalid_url'
]);

/**
 * Retry delivery of persisted pending intents. Claim/lease transactions finish
 * before HTTP requests begin; this worker never holds PostgreSQL row locks while
 * waiting for the independent Ledger. It repairs ACK state only: route-specific
 * domain mutations still require their normal authenticated retry/reconciler.
 */
export async function resumePendingPrivacyRecoveryLedgerAcks({
  pool,
  limit = 25,
  operationIds = null,
  leaseMs = 30_000,
  baseBackoffMs = 5_000,
  maxBackoffMs = 60 * 60 * 1000,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now
}) {
  if (!pool || typeof pool.connect !== 'function' ||
      !env.PRIVACY_RECOVERY_LEDGER_URL ||
      typeof env.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET !== 'string' ||
      env.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET.length < 32 ||
      (env.PRIVACY_RECOVERY_LEDGER_REQUIRED !== 'true' && env.NODE_ENV !== 'production') ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (operationIds !== null && (!Array.isArray(operationIds) || operationIds.length < 1 ||
        operationIds.length > 100 || operationIds.some(id =>
          typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
        new Set(operationIds).size !== operationIds.length)) ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 5 * 60_000 ||
      !Number.isSafeInteger(baseBackoffMs) || baseBackoffMs < 100 ||
      !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < baseBackoffMs) {
    throw new TypeError('privacy_recovery_ack_resumer_options_invalid');
  }

  const leaseToken = randomUUID();
  const claimed = await withPooledTransaction(pool, async client => {
    const result = await client.query(
      `WITH candidates AS (
         SELECT operation_id
           FROM privacy_recovery_operations
          WHERE status = 'pending'
            AND ack_next_attempt_at <= statement_timestamp()
            AND (ack_lease_expires_at IS NULL OR ack_lease_expires_at <= statement_timestamp())
            AND ($4::uuid[] IS NULL OR operation_id = ANY($4::uuid[]))
          ORDER BY ack_next_attempt_at, created_at, operation_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE privacy_recovery_operations AS operation
          SET ack_lease_token = $2,
              ack_lease_expires_at = statement_timestamp() + ($3::int * INTERVAL '1 millisecond'),
              ack_attempts = operation.ack_attempts + 1,
              updated_at = statement_timestamp()
         FROM candidates
        WHERE operation.operation_id = candidates.operation_id
       RETURNING operation.operation_id, operation.event_payload, operation.ack_attempts`,
      [limit, leaseToken, leaseMs, operationIds]
    );
    return result.rows;
  });

  const summary = {
    claimed: claimed.length,
    acknowledged: 0,
    deferred: 0,
    leaseLost: 0
  };

  for (const row of claimed) {
    try {
      const acknowledgement = await deliverPrivacyRecoveryLedgerPayload(row.event_payload, {
        env, fetchImpl, now
      });
      if (acknowledgement?.acknowledged !== true ||
          acknowledgement.eventId !== row.operation_id ||
          !Number.isSafeInteger(acknowledgement.sequence) ||
          acknowledgement.sequence < 1) {
        throw new Error('privacy_recovery_ledger_invalid_acknowledgement');
      }

      const stored = await withPooledTransaction(pool, async client => {
        const result = await client.query(
          `UPDATE privacy_recovery_operations
              SET status = 'acknowledged',
                  ledger_sequence = $3,
                  acknowledged_at = statement_timestamp(),
                  ack_lease_token = NULL,
                  ack_lease_expires_at = NULL,
                  ack_next_attempt_at = statement_timestamp(),
                  ack_last_error_code = NULL,
                  updated_at = statement_timestamp()
            WHERE operation_id = $1
              AND status = 'pending'
              AND ack_lease_token = $2
            RETURNING operation_id`,
          [row.operation_id, leaseToken, acknowledgement.sequence]
        );
        return result.rowCount === 1;
      });
      if (stored) summary.acknowledged += 1;
      else summary.leaseLost += 1;
    } catch (error) {
      const attempts = Math.max(1, Number(row.ack_attempts) || 1);
      const delay = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.min(attempts - 1, 10)));
      const code = SAFE_LEDGER_ERRORS.has(error?.message)
        ? error.message
        : 'privacy_recovery_ledger_delivery_failed';
      try {
        const deferred = await withPooledTransaction(pool, async client => {
          const result = await client.query(
            `UPDATE privacy_recovery_operations
                SET ack_lease_token = NULL,
                    ack_lease_expires_at = NULL,
                    ack_next_attempt_at = statement_timestamp() + ($3::int * INTERVAL '1 millisecond'),
                    ack_last_error_code = $4,
                    updated_at = statement_timestamp()
              WHERE operation_id = $1
                AND status = 'pending'
                AND ack_lease_token = $2`,
            [row.operation_id, leaseToken, delay, code]
          );
          return result.rowCount === 1;
        });
        if (deferred) summary.deferred += 1;
        else summary.leaseLost += 1;
      } catch {
        // Leave the lease to expire. A later worker can safely retry the same
        // immutable event ID and payload; the Ledger is idempotent by event ID.
        summary.leaseLost += 1;
      }
    }
  }

  return summary;
}
