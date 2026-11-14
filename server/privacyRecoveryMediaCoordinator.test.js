import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runPrivateMediaPrivacyRecovery } from './privacyRecoveryMediaCoordinator.js';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const key = 'recovery-test-key-material-which-is-long-enough';
const subjectRef = createHmac('sha256', key).update(userId, 'utf8').digest('hex');

function poolFor({ events = [], users = [{ id: userId }], voiceIntros = [], photos = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN TRANSACTION')) return { rows: [] };
      if (sql.includes('FROM privacy_recovery_events')) return { rows: events };
      if (sql === 'SELECT id FROM users') return { rows: users };
      if (sql === 'SELECT id FROM profile_voice_intros') return { rows: voiceIntros };
      if (sql === 'SELECT id FROM photo_assets') return { rows: photos };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('unexpected_query');
    },
    release() { calls.push('RELEASE'); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

const isolatedEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: key
};

test('coordinator stops at the first unsupported event without replaying later events', async () => {
  const { pool, calls } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174001',
      event_type: 'account_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: null
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174002',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: 'b'.repeat(64)
    }]
  });
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 0, throughSequence: 2
  });
  assert.deepEqual(result, {
    complete: false,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: 1,
    blockedEventType: 'account_erasure_requested',
    throughSequence: 2
  });
  assert.equal(calls.includes('COMMIT'), true);
});

test('coordinator rejects an incomplete staged sequence range', async () => {
  const { pool, calls } = poolFor({ events: [] });
  await assert.rejects(
    runPrivateMediaPrivacyRecovery({
      pool, env: isolatedEnv, snapshotLedgerSequence: 10, throughSequence: 11
    }),
    /privacy_recovery_executor_sequence_range_incomplete/
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});

test('coordinator requires an explicitly isolated non-production environment', async () => {
  const { pool, calls } = poolFor();
  await assert.rejects(
    runPrivateMediaPrivacyRecovery({
      pool,
      env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 0,
      throughSequence: 0
    }),
    /privacy_recovery_executor_requires_isolated_restore/
  );
  assert.equal(calls.length, 0);
});

test('empty verified range completes without touching domain state', async () => {
  const { pool, calls } = poolFor();
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 25, throughSequence: 25
  });
  assert.deepEqual(result, {
    complete: true,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: null,
    blockedEventType: null,
    throughSequence: 25
  });
  assert.equal(calls.some(sql => sql === 'SELECT id FROM users'), true);
});
