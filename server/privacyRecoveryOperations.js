import { createPrivacyRecoveryLedgerPayload, deliverPrivacyRecoveryLedgerPayload } from './privacyRecoveryLedger.js';

function assertUuid(value) {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('privacy_recovery_operation_id_invalid');
  }
}

async function withClient(pool, callback) {
  const client = await pool.connect();
  try { return await callback(client); }
  finally { client.release(); }
}

async function persistIntent(pool, operationId, payload) {
  await withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO privacy_recovery_operations
           (operation_id, event_id, event_payload, status)
         VALUES ($1, $1, $2::jsonb, 'pending')
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING operation_id`,
        [operationId, JSON.stringify(payload)]
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query(
          `SELECT 1 FROM privacy_recovery_operations
            WHERE operation_id = $1 AND event_payload = $2::jsonb
            FOR SHARE`,
          [operationId, JSON.stringify(payload)]
        );
        if (existing.rowCount !== 1) throw new Error('privacy_recovery_operation_id_conflict');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

/**
 * Persist intent, obtain the independent ledger ACK, then apply the domain
 * mutation and mark the operation applied in one PostgreSQL transaction.
 *
 * operationId must be a caller-stable idempotency UUID reused across retries.
 * apply(client) must revalidate ownership, consent, eligibility and locks inside
 * this transaction; it must not perform external side effects.
 */
export async function runAckGatedPrivacyRecoveryOperation({
  pool, operationId, event, apply, env = process.env, fetchImpl = globalThis.fetch, now = Date.now
}) {
  if (!pool || typeof pool.connect !== 'function' || typeof apply !== 'function') {
    throw new TypeError('privacy_recovery_operation_dependencies_invalid');
  }
  assertUuid(operationId);
  if (!event || typeof event !== 'object' || !event.occurredAt) {
    throw new TypeError('privacy_recovery_operation_event_requires_stable_occurred_at');
  }

  const payload = createPrivacyRecoveryLedgerPayload({
    ...event,
    eventId: operationId
  }, { env });
  if (payload.skipped) throw new Error('privacy_recovery_ledger_ack_required');

  await persistIntent(pool, operationId, payload);

  // A timeout after remote acceptance is safe: retry sends the same immutable
  // event ID and payload, and the ledger must return its original ACK.
  const acknowledgement = await deliverPrivacyRecoveryLedgerPayload(payload, { env, fetchImpl, now });
  if (acknowledgement?.acknowledged !== true ||
      acknowledgement.eventId !== operationId ||
      !Number.isSafeInteger(acknowledgement.sequence) || acknowledgement.sequence < 1) {
    throw new Error('privacy_recovery_ledger_ack_required');
  }

  // Persist the ACK in its own transaction. If the subsequent domain
  // transaction fails, a resumer can continue from acknowledged without
  // depending on the remote service being available again.
  await withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const locked = await client.query(
        `SELECT status, ledger_sequence
           FROM privacy_recovery_operations
          WHERE operation_id = $1
          FOR UPDATE`,
        [operationId]
      );
      if (locked.rowCount !== 1) throw new Error('privacy_recovery_operation_intent_missing');
      const operation = locked.rows[0];
      if (operation.status === 'pending') {
        const updated = await client.query(
          `UPDATE privacy_recovery_operations
              SET status = 'acknowledged', ledger_sequence = $2,
                  acknowledged_at = statement_timestamp(), updated_at = statement_timestamp()
            WHERE operation_id = $1 AND status = 'pending'`,
          [operationId, acknowledgement.sequence]
        );
        if (updated.rowCount !== 1) throw new Error('privacy_recovery_operation_ack_state_conflict');
      } else if (Number(operation.ledger_sequence) !== acknowledgement.sequence) {
        throw new Error('privacy_recovery_operation_ack_sequence_conflict');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });

  return withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const locked = await client.query(
        `SELECT status, ledger_sequence
           FROM privacy_recovery_operations
          WHERE operation_id = $1
          FOR UPDATE`,
        [operationId]
      );
      if (locked.rowCount !== 1) throw new Error('privacy_recovery_operation_intent_missing');
      const operation = locked.rows[0];
      if (operation.status === 'applied') {
        await client.query('COMMIT');
        return { operationId, applied: true, duplicate: true, sequence: Number(operation.ledger_sequence) };
      }
      if (operation.status !== 'acknowledged') {
        throw new Error('privacy_recovery_operation_ack_required');
      }

      // Route-specific callback performs its mutation here. It must re-check
      // current state because it may have changed while the remote ACK was in flight.
      const result = await apply(client);
      const applied = await client.query(
        `UPDATE privacy_recovery_operations
            SET status = 'applied', applied_at = statement_timestamp(),
                updated_at = statement_timestamp()
          WHERE operation_id = $1 AND status = 'acknowledged'`,
        [operationId]
      );
      if (applied.rowCount !== 1) throw new Error('privacy_recovery_operation_apply_state_conflict');
      await client.query('COMMIT');
      return { operationId, applied: true, duplicate: false, sequence: acknowledgement.sequence, result };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });;
}
