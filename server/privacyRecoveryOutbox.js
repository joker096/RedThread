import { createPrivacyRecoveryLedgerPayload, deliverPrivacyRecoveryLedgerPayload } from './privacyRecoveryLedger.js';

const MAX_ATTEMPTS = 12;
const LEASE_SECONDS = 60;
const SAFE_DELIVERY_ERROR_CODES = new Set([
  'privacy_recovery_ledger_invalid_url',
  'privacy_recovery_ledger_not_configured',
  'privacy_recovery_ledger_unavailable',
  'privacy_recovery_ledger_rejected_event',
  'privacy_recovery_ledger_invalid_acknowledgement'
]);

function safeDeliveryErrorCode(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  return SAFE_DELIVERY_ERROR_CODES.has(code) ? code : 'privacy_recovery_delivery_failed';
}

export async function enqueuePrivacyRecoveryEvent(client, input, { env = process.env } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('privacy_recovery_outbox_client_required');
  const payload = createPrivacyRecoveryLedgerPayload(input, { env });
  if (payload.skipped) return payload;
  const serializedPayload = JSON.stringify(payload);
  const inserted = await client.query(
    `INSERT INTO privacy_recovery_ledger_outbox
       (event_id, event_payload, status, next_attempt_at)
     VALUES ($1, $2::jsonb, 'pending', statement_timestamp())
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [payload.event_id, serializedPayload]
  );
  if (inserted.rowCount === 1) return { queued: true, eventId: payload.event_id };

  // Idempotency is valid only for the exact same immutable event. Reusing an
  // event UUID with different pseudonyms, resource or event type is a hard
  // conflict, never a silently successful enqueue.
  const existing = await client.query(
    `SELECT event_id
       FROM privacy_recovery_ledger_outbox
      WHERE event_id = $1 AND event_payload = $2::jsonb
      FOR SHARE`,
    [payload.event_id, serializedPayload]
  );
  if (existing.rowCount !== 1) throw new Error('privacy_recovery_outbox_event_id_conflict');
  return { queued: true, duplicate: true, eventId: payload.event_id };
}

export async function processPrivacyRecoveryOutboxBatch({
  pool, env = process.env, fetchImpl = globalThis.fetch, now = Date.now, limit = 25
}) {
  if (!pool || typeof pool.connect !== 'function' || !Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new TypeError('privacy_recovery_outbox_worker_input_invalid');
  }
  const client = await pool.connect();
  let claimed;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH candidates AS (
         SELECT event_id
           FROM privacy_recovery_ledger_outbox
          WHERE (status = 'pending' AND next_attempt_at <= statement_timestamp())
             OR (status = 'processing' AND lease_expires_at <= statement_timestamp())
          ORDER BY created_at, event_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE privacy_recovery_ledger_outbox AS outbox
          SET status = 'processing',
              lease_token = gen_random_uuid(),
              attempts = attempts + 1,
              lease_expires_at = statement_timestamp() + ($2::integer * interval '1 second'),
              updated_at = statement_timestamp()
         FROM candidates
        WHERE outbox.event_id = candidates.event_id
       RETURNING outbox.event_id, outbox.event_payload, outbox.attempts, outbox.lease_token`,
      [limit, LEASE_SECONDS]
    );
    claimed = result.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const results = [];
  for (const row of claimed) {
    try {
      const acknowledgement = await deliverPrivacyRecoveryLedgerPayload(row.event_payload, { env, fetchImpl, now });
      if (!acknowledgement.acknowledged) throw new Error('privacy_recovery_ledger_ack_required');
      const ackClient = await pool.connect();
      try {
        const acknowledged = await ackClient.query(
          `UPDATE privacy_recovery_ledger_outbox
              SET status = 'acknowledged', ledger_sequence = $2,
                  acknowledged_at = statement_timestamp(), lease_expires_at = NULL, lease_token = NULL,
                  last_error_code = NULL, updated_at = statement_timestamp()
            WHERE event_id = $1 AND status = 'processing' AND lease_token = $3
          RETURNING event_id`,
          [row.event_id, acknowledgement.sequence, row.lease_token]
        );
        if (acknowledged.rowCount !== 1) {
          const current = await ackClient.query(
            'SELECT status FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
            [row.event_id]
          );
          if (current.rows[0]?.status !== 'acknowledged') {
            throw new Error('privacy_recovery_outbox_lease_lost');
          }
        }
      } finally {
        ackClient.release();
      }
      results.push({ eventId: row.event_id, acknowledged: true, sequence: acknowledgement.sequence });
    } catch (error) {
      const retryClient = await pool.connect();
      try {
        await retryClient.query(
          `UPDATE privacy_recovery_ledger_outbox
              SET status = CASE WHEN attempts >= $2 THEN 'dead' ELSE 'pending' END,
                  next_attempt_at = statement_timestamp() +
                    (LEAST(3600, power(2, LEAST(attempts, 10))) * interval '1 second'),
                  lease_expires_at = NULL, lease_token = NULL,
                  last_error_code = $3,
                  updated_at = statement_timestamp()
            WHERE event_id = $1 AND status = 'processing' AND lease_token = $4`,
          [row.event_id, MAX_ATTEMPTS, safeDeliveryErrorCode(error), row.lease_token]
        );
      } finally {
        retryClient.release();
      }
      results.push({ eventId: row.event_id, acknowledged: false, error: safeDeliveryErrorCode(error) });
    }
  }
  return { claimed: claimed.length, results };
}
