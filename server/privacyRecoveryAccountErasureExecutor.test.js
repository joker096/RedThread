import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { applyAccountErasurePrivacyRecoveryEvent, preflightAccountErasurePrivacyRecovery } from './privacyRecoveryAccountErasureExecutor.js';
import { verifyAccountErasurePrivacyRecovery } from './privacyRecoveryAccountErasureVerification.js';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const eventId = '123e4567-e89b-42d3-a456-426614174001';
const key = 'account-erasure-recovery-test-key-material-long-enough';
const isolatedEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: key,
  PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test',
  PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner',
  PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY',
  ACCOUNT_REUSE_HMAC_KEY: 'd'.repeat(64)
};
const mapping = {
  sequence: '1',
  eventId,
  eventType: 'account_erasure_requested',
  status: 'matched',
  subjectUserId: userId,
  resourceId: null
};

function poolWithQueries(responses = []) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('current_database()')) {
        return { rowCount: 1, rows: [{ database_name: 'vow_restore_test', database_role: 'vow_restore_runner' }] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(String(sql).trim()) ||
          String(sql).includes('pg_advisory_xact_lock')) {
        return { rowCount: 0, rows: [] };
      }
      return responses.shift() || { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

test('account erasure executor refuses production before opening a database connection', async () => {
  let connects = 0;
  await assert.rejects(
    applyAccountErasurePrivacyRecoveryEvent({
      pool: { async connect() { connects += 1; throw new Error('must_not_connect'); } },
      mapping,
      pseudonymKey: key,
      env: { ...isolatedEnv, NODE_ENV: 'production' }
    }),
    /privacy_recovery_account_erasure_requires_isolated_restore/
  );
  assert.equal(connects, 0);
});

test('account erasure executor rejects a subject pseudonym mismatch before domain writes', async () => {
  const wrongMapping = { ...mapping, subjectUserId: '123e4567-e89b-42d3-a456-426614174099' };
  const staged = {
    ledger_sequence: '1',
    event_id: eventId,
    schema_version: 1,
    event_type: 'account_erasure_requested',
    subject_ref: createHmac('sha256', key).update(userId, 'utf8').digest('hex'),
    resource_ref: null,
    occurred_at: new Date('2026-11-16T10:00:00.000Z'),
    received_at: new Date('2026-11-16T10:00:01.000Z')
  };
  const { pool, calls } = poolWithQueries([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [staged] }
  ]);
  await assert.rejects(
    applyAccountErasurePrivacyRecoveryEvent({ pool, mapping: wrongMapping, pseudonymKey: key, env: isolatedEnv }),
    /privacy_recovery_account_erasure_subject_mapping_mismatch/
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE users') || call.sql.includes('DELETE FROM')), false);
});

test('account erasure verifier refuses production before opening a database connection', async () => {
  let connects = 0;
  await assert.rejects(
    verifyAccountErasurePrivacyRecovery({
      pool: { async connect() { connects += 1; throw new Error('must_not_connect'); } },
      env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 0,
      throughSequence: 1
    }),
    /privacy_recovery_account_erasure_verification_requires_isolated_restore/
  );
  assert.equal(connects, 0);
});

test('account erasure preflight blocks unresolved Paddle checkout before any batch writes', async () => {
  const staged = {
    ledger_sequence: '1',
    event_id: eventId,
    schema_version: 1,
    event_type: 'account_erasure_requested',
    subject_ref: createHmac('sha256', key).update(userId, 'utf8').digest('hex'),
    resource_ref: null,
    occurred_at: new Date('2026-11-16T10:00:00.000Z'),
    received_at: new Date('2026-11-16T10:00:01.000Z')
  };
  const { pool, calls } = poolWithQueries([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [staged] },
    { rowCount: 1, rows: [{
      id: userId, email: 'restore-user@example.invalid', status: 'active',
      paddle_customer_id: null, paddle_subscription_id: null,
      paddle_subscription_status: null
    }] },
    { rowCount: 1, rows: [{ status: 'pending', plan: '1month' }] }
  ]);
  await assert.rejects(
    preflightAccountErasurePrivacyRecovery({
      pool, mapping, pseudonymKey: key, env: isolatedEnv
    }),
    /privacy_recovery_account_erasure_paddle_checkout_unresolved/
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE users') || call.sql.includes('DELETE FROM')), false);
});
