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
const isolatedEnv = { NODE_ENV: 'test', PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true', PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test', PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner', PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY' };

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
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rowCount: null, rows: [] };
      if (sql.includes('SELECT current_database() AS database_name')) return { rowCount: 1, rows: [{ database_name: 'vow_restore_test', database_role: 'vow_restore_runner' }] };
      if (sql.includes('FROM pg_roles r')) return { rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true, has_role_memberships: false, has_relation_write_privileges: false, has_column_write_privileges: false, has_sequence_write_privileges: false, has_schema_create_privileges: false, has_database_create_privilege: false }], rowCount: 1 };
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
  const result = await applyPrivateMediaPrivacyRecoveryEvent({ pool, mapping, env: isolatedEnv, pseudonymKey: 'x'.repeat(32) });
  assert.deepEqual(result, { applied: false, alreadyApplied: true, outcome: 'photo_erasure_queued' });
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), false);
  assert.equal(calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).length, 2);
  assert.equal(calls.some(call => call.sql.includes('FROM privacy_recovery_replay_receipts') && call.sql.includes('FOR UPDATE')), false);
  assert.equal(calls.some(call => call.sql.includes('FROM privacy_recovery_events') && call.sql.includes('FOR SHARE')), false);
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
    applyPrivateMediaPrivacyRecoveryEvent({ pool, mapping, env: isolatedEnv, pseudonymKey: 'x'.repeat(32) }),
    /privacy_recovery_replay_receipt_conflict/
  );
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
});

test('unresolved mapping without a receipt is rejected before any domain mutation', async () => {
  const { pool, calls } = fakePool();
  await assert.rejects(
    applyPrivateMediaPrivacyRecoveryEvent({ pool, mapping, env: isolatedEnv, pseudonymKey: 'x'.repeat(32) }),
    /privacy_recovery_mapping_unresolved/
  );
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO private_photo_purge_queue')), false);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM photo_assets')), false);
});

test('executor replays gift address draft consent withdrawal under recipient and pair locks', async () => {
  const { createHmac } = await import('node:crypto');
  const userId = '123e4567-e89b-42d3-a456-426614174010';
  const senderId = '123e4567-e89b-42d3-a456-426614174011';
  const orderId = '123e4567-e89b-42d3-a456-426614174012';
  const eventId = '123e4567-e89b-42d3-a456-426614174013';
  const key = 'gift-replay-test-key-material-that-is-long-enough';
  const hmac = value => createHmac('sha256', key).update(value, 'utf8').digest('hex');
  const giftEvent = {
    ledger_sequence: '77', event_id: eventId, schema_version: 1,
    event_type: 'gift_address_draft_consent_withdrawn',
    subject_ref: hmac(userId), resource_ref: hmac(orderId),
    occurred_at: new Date('2026-11-14T08:00:00.000Z'),
    received_at: new Date('2026-11-14T08:00:01.000Z')
  };
  const giftDigest = createHash('sha256').update(JSON.stringify([
    '77', eventId, '1', giftEvent.event_type, giftEvent.subject_ref,
    giftEvent.resource_ref, giftEvent.occurred_at.toISOString(),
    giftEvent.received_at.toISOString()
  ])).digest('hex');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rowCount: null, rows: [] };
      if (sql.includes('SELECT current_database() AS database_name')) return { rowCount: 1, rows: [{ database_name: 'vow_restore_test', database_role: 'vow_restore_runner' }] };
      if (sql.includes('FROM pg_roles r')) return { rowCount: 1, rows: [{
        rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
        rolbypassrls: false, rolcanlogin: true, has_role_memberships: false,
        has_relation_write_privileges: false, has_column_write_privileges: false,
        has_sequence_write_privileges: false, has_schema_create_privileges: false,
        has_database_create_privilege: false
      }] };
      if (sql.includes('FROM privacy_recovery_replay_receipts')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM privacy_recovery_events')) return { rowCount: 1, rows: [giftEvent] };
      if (sql.includes('FROM gift_delivery_orders')) return { rowCount: 1, rows: [{ sender_id: senderId, recipient_id: userId }] };
      if (sql === 'SELECT id FROM users WHERE id = $1') return { rowCount: 1, rows: [{ id: userId }] };
      if (sql.includes('FROM gift_address_draft_consent_events')) return { rowCount: 1, rows: [{ action: 'granted', consent_version: 1 }] };
      if (sql.includes('DELETE FROM gift_address_drafts')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO gift_address_draft_consent_events')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO privacy_recovery_replay_receipts')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO privacy_recovery_replay_effects')) return { rowCount: 1, rows: [] };
      throw new Error('unexpected_query:' + sql);
    },
    release() {}
  };
  const result = await applyPrivateMediaPrivacyRecoveryEvent({
    pool: { async connect() { return client; } },
    mapping: {
      sequence: '77', eventId, eventType: giftEvent.event_type,
      status: 'matched', subjectUserId: userId, resourceId: orderId
    },
    env: isolatedEnv,
    pseudonymKey: key
  });
  assert.deepEqual(result, {
    applied: true, alreadyApplied: false,
    outcome: 'gift_address_draft_consent_withdrawn'
  });
  assert.equal(calls.some(call => call.sql.includes('gift-safety-user:')), true);
  assert.equal(calls.some(call => call.sql.includes('gift-safety:')), true);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM gift_address_drafts')), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO gift_address_draft_consent_events')), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO privacy_recovery_replay_receipts')), true);
});

test('executor rejects event types outside the private-media allowlist', async () => {
  await assert.rejects(
    applyPrivateMediaPrivacyRecoveryEvent({
      pool: { async connect() { throw new Error('must_not_connect'); } },
      mapping: { ...mapping, eventType: 'account_erasure_requested' },
      env: isolatedEnv,
      pseudonymKey: 'x'.repeat(32)
    }),
    /privacy_recovery_media_executor_input_invalid/
  );
});
