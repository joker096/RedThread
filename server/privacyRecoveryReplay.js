import { createHash } from 'node:crypto';

const EVENT_TYPES = new Set([
  'account_erasure_requested',
  'voice_intro_consent_withdrawn',
  'voice_intro_erasure_requested',
  'private_photo_erasure_requested',
  'identity_l3_consent_withdrawn',
  'ad_consent_revoked',
  'gift_order_consent_withdrawn'
]);

function validEvent(event, expectedSequence) {
  return Boolean(event && typeof event === 'object' && !Array.isArray(event) &&
    event.sequence === expectedSequence &&
    typeof event.event_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) &&
    event.schema_version === 1 && EVENT_TYPES.has(event.event_type) &&
    typeof event.subject_ref === 'string' && /^[a-f0-9]{64}$/i.test(event.subject_ref) &&
    (event.resource_ref === null || event.resource_ref === undefined ||
      (typeof event.resource_ref === 'string' && /^[a-f0-9]{64}$/i.test(event.resource_ref))) &&
    typeof event.occurred_at === 'string' && Number.isFinite(Date.parse(event.occurred_at)) &&
    typeof event.received_at === 'string' && Number.isFinite(Date.parse(event.received_at)));
}

function canonicalEvent(event) {
  return [
    String(event.sequence), event.event_id, String(event.schema_version), event.event_type,
    event.subject_ref.toLowerCase(), event.resource_ref?.toLowerCase() ?? null,
    new Date(event.occurred_at).toISOString(), new Date(event.received_at).toISOString()
  ];
}

export async function stagePrivacyRecoveryEvents(client, {
  snapshotLedgerSequence,
  events
}) {
  if (!client || typeof client.query !== 'function' ||
      !Number.isSafeInteger(snapshotLedgerSequence) || snapshotLedgerSequence < 0 ||
      !Array.isArray(events)) {
    throw new TypeError('privacy_recovery_stage_input_invalid');
  }
  const seenIds = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!validEvent(event, index + 1) || seenIds.has(event.event_id)) {
      throw new Error('privacy_recovery_stage_archive_invalid');
    }
    seenIds.add(event.event_id);
  }
  const watermark = events.length;
  if (snapshotLedgerSequence > watermark) {
    throw new Error('privacy_recovery_snapshot_watermark_ahead_of_archive');
  }
  const pending = events.filter(event => event.sequence > snapshotLedgerSequence);
  if (pending.length === 0) {
    return { snapshotLedgerSequence, stagedCount: 0, throughSequence: watermark };
  }

  await client.query('BEGIN');
  let insertedCount = 0;
  let alreadyPresentCount = 0;
  try {
    for (const event of pending) {
      const values = [
        event.sequence, event.event_id, event.schema_version, event.event_type,
        event.subject_ref.toLowerCase(), event.resource_ref?.toLowerCase() ?? null,
        event.occurred_at, event.received_at
      ];
      const inserted = await client.query(
        `INSERT INTO privacy_recovery_events
          (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING ledger_sequence`,
        values
      );
      if (inserted.rowCount === 1) {
        insertedCount += 1;
        continue;
      }

      const existing = await client.query(
        `SELECT ledger_sequence, event_id, schema_version, event_type, subject_ref,
                resource_ref, occurred_at, received_at
           FROM privacy_recovery_events
          WHERE ledger_sequence = $1 OR event_id = $2
          FOR SHARE`,
        [event.sequence, event.event_id]
      );
      if (existing.rowCount !== 1) throw new Error('privacy_recovery_stage_conflict_unresolved');
      const row = existing.rows[0];
      const actual = [
        String(row.ledger_sequence), row.event_id, String(row.schema_version), row.event_type,
        String(row.subject_ref).toLowerCase(), row.resource_ref?.toLowerCase() ?? null,
        new Date(row.occurred_at).toISOString(), new Date(row.received_at).toISOString()
      ];
      const expected = canonicalEvent(event);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error('privacy_recovery_stage_conflicting_existing_event');
      }
      alreadyPresentCount += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
  return {
    snapshotLedgerSequence,
    stagedCount: insertedCount,
    alreadyPresentCount,
    throughSequence: watermark
  };
}
