import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyPrivateMediaPrivacyRecoveryEvent } from './privacyRecoveryMediaExecutor.js';

const event = {
  ledger_sequence: '42',
  event_id: '123e4567-e89b-42d3-a456-426614174000',
  schema_version: 1,
  event_type: 'private_photo_erasure_requested',
  subject_ref: 'a'.repeat(64),
  resource_ref: 'b'.repeat(64),
  occurred_at: new Date('2026-11-14T08:00:00.000Z'),
  received_at: new Date('2026-11-14T08:00:01.000Z')
};
const digest = createHash('sha256').update(JSON.stringify([
  '42', event.event_id, '1', event.event_type, event.subject_ref, event.resource_ref,
  event.occurred_at.toISOString(), event.received_at.toISOString()
])).digest('hex');
const mapping = {
  sequence: '42',
  eventId: event.event_id,
  eventType: event.event_type,
  status: 'subject_unmatched',
  subjectUserId: null,
  resourceId: null
};

function fakePool({ receipt = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('FROM privacy_recovery_replay_receipts')) {
        return { rowCount: receipt ? 1 : 0, rows: receipt ? [receipt] : [] };
      }
      if (sql.includes('FROM privacy_recovery_events')) return { rowCount: 1, rows: [event] };
      throw new Error('unexpected_query:' + sql);
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

test('exact replay receipt is idempotent and checked before requiring a resource mapping', async () => {
  const receipt = {
    ledger_sequence: '42',
    event_id: event.event_id,
    event_digest: digest,
    event_type: event.event_type,
    outcome_code: 'photo_erasure_queued'
  };
  const { pool, calls } = fakePool({ receipt });
  const result = await applyPrivateMediaPrivacyRecoveryEvent({ pool, mapping, pseudonymKey: 'x'.repeat(32) });
  assert.deepEqual(result, { applied: false, alreadyApplied: true, outcome: 'photo_erasure_queued' });
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), false);
  assert.equal(calls.some(call => call.sql.includes('pg_advisory_xact_lock')), false);
});

test('conflicting receipt identity or digest fails closed and rolls back', async () => {
  const receipt = {
    ledger_sequence: '42',
    event_id: event.event_id,
    event_digest: 'c'.repeat(64),
    event_type: event.event_type,
    outcome_code: 'photo_erasure_queued'
  };
  const { pool, calls } = fakePool({ receipt });
  await assert.rejects(
    applyPrivateMediaPrivacyRecoveryEvent({ pool, mapping, pseudonymKey: 'x'.repeat(32) }),
    /privacy_recovery_replay_receipt_conflict/
  );
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
});

test('unresolved mapping without a receipt is rejected before any domain mutation', async () => {
  const { pool, calls } = fakePool();
  await assert.rejects(
    applyPrivateMediaPrivacyRecoveryEvent({ pool, mapping, pseudonymKey: 'x'.repeat(32) }),
    /privacy_recovery_mapping_unresolved/
  );
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO private_photo_purge_queue')), false);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM photo_assets')), false);
});

test('executor rejects event types outside the private-media allowlist', async () => {
  await assert.rejects(
    applyPrivateMediaPrivacyRecoveryEvent({
      pool: { async connect() { throw new Error('must_not_connect'); } },
      mapping: { ...mapping, eventType: 'account_erasure_requested' },
      pseudonymKey: 'x'.repeat(32)
    }),
    /privacy_recovery_media_executor_input_invalid/
  );
});
