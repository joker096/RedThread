import { createHash } from 'node:crypto';
import { createPrivacyRecoveryLedgerPayload, deliverPrivacyRecoveryLedgerPayload } from './privacyRecoveryLedger.js';


/**
 * Derive a retry-stable UUID for a one-time resource transition. The generation
 * must identify the consent grant / lifecycle instance, not the HTTP attempt.
 * This is intentionally domain-separated and deterministic so clients do not
 * need to invent or persist idempotency keys for server-owned transitions.
 */
export function derivePrivacyRecoveryOperationId({ eventType, userId, resourceId = null, generation }) {
  if (typeof eventType !== 'string' || !/^[a-z][a-z0-9_]{2,80}$/.test(eventType) ||
      typeof userId !== 'string' || !userId ||
      (resourceId !== null && (typeof resourceId !== 'string' || !resourceId)) ||
      (typeof generation !== 'string' && !(typeof generation === 'number' && Number.isSafeInteger(generation))) ||
      String(generation).length === 0 || String(generation).length > 200) {
    throw new TypeError('privacy_recovery_operation_identity_invalid');
  }
  const identity = JSON.stringify(['vow-privacy-recovery-operation-v1', eventType, userId, resourceId, String(generation)]);
  const bytes = createHash('sha256').update(identity, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertUuid(value) {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('privacy_recovery_operation_id_invalid');
  }
}

async function withClient(pool, callback) {
  const client = await pool.connect();
  try { return await callback(client); }
  finally { client.release(); }
}

async function persistIntent(pool, operationId, payload) {
  return withClient(pool, async client => {
    await client.query('BEGIN');
    try {
      const inserted = await client.query(
        `INSERT INTO privacy_recovery_operations
           (operation_id, event_id, event_payload, status)
         VALUES ($1, $1, $2::jsonb, 'pending')
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING operation_id, status, ledger_sequence, event_payload`,
        [operationId, JSON.stringify(payload)]
      );
      let intent;
      if (inserted.rowCount === 1) {
        intent = inserted.rows[0];
      } else {
        const existing = await client.query(
          `SELECT status, ledger_sequence, event_payload FROM privacy_recovery_operations
            WHERE operation_id = $1
            FOR SHARE`,
          [operationId]
        );
        if (existing.rowCount !== 1) throw new Error('privacy_recovery_operation_id_conflict');
        const storedPayload = existing.rows[0].event_payload;
        const sameIdentity = storedPayload?.event_id === payload.event_id &&
          storedPayload?.event_type === payload.event_type &&
          storedPayload?.subject_ref === payload.subject_ref &&
          (storedPayload?.resource_ref ?? null) === (payload.resource_ref ?? null) &&
          storedPayload?.schema_version === payload.schema_version;
        if (!sameIdentity) throw new Error('privacy_recovery_operation_id_conflict');
        intent = existing.rows[0];
      }
      await client.query('COMMIT');
      return intent;
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
  if (!event || typeof event !== 'object') {
    throw new TypeError('privacy_recovery_operation_event_invalid');
  }

  const candidatePayload = createPrivacyRecoveryLedgerPayload({
    ...event,
    occurredAt: event.occurredAt || new Date(now()).toISOString(),
    eventId: operationId
  }, { env });
  if (candidatePayload.skipped) throw new Error('privacy_recovery_ledger_ack_required');

  // The first committed intent owns occurred_at and the exact payload. Retries
  // reuse that stored payload even when a later HTTP attempt has a new timestamp.
  const intent = await persistIntent(pool, operationId, candidatePayload);
  const payload = intent.event_payload;
  let ledgerSequence = Number(intent.ledger_sequence);

  // Only pending intents need a network call. Once an ACK is durably recorded,
  // recovery can resume even while the independent Ledger is temporarily down.
  if (intent.status === 'pending') {
    // A timeout after remote acceptance is safe: retry sends the same immutable
    // event ID and payload, and the ledger must return its original ACK.
    const acknowledgement = await deliverPrivacyRecoveryLedgerPayload(payload, { env, fetchImpl, now });
    if (acknowledgement?.acknowledged !== true ||
        acknowledgement.eventId !== operationId ||
        !Number.isSafeInteger(acknowledgement.sequence) || acknowledgement.sequence < 1) {
      throw new Error('privacy_recovery_ledger_ack_required');
    }
    ledgerSequence = acknowledgement.sequence;

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
      } else if (Number(operation.ledger_sequence) !== ledgerSequence) {
        throw new Error('privacy_recovery_operation_ack_sequence_conflict');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    });
  } else if (!Number.isSafeInteger(ledgerSequence) || ledgerSequence < 1) {
    throw new Error('privacy_recovery_operation_ack_sequence_missing');
  }

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
      return { operationId, applied: true, duplicate: false, sequence: ledgerSequence, result };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}
