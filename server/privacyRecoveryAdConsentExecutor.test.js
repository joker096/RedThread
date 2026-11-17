import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  applyAdConsentRevocationPrivacyRecoveryEvent,
  preflightAdConsentRevocationPrivacyRecovery
} from './privacyRecoveryAdConsentExecutor.js';
import { verifyAdConsentRevocationPrivacyRecovery } from './privacyRecoveryAdConsentVerification.js';

const userId = '123e4567-e89b-42d3-a456-426614174100';
const eventId = '123e4567-e89b-42d3-a456-426614174101';
const key = 'ad-consent-recovery-test-key-material-long-enough';
const isolatedEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: key,
  PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test',
  PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner',
  PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY'
};
const mapping = {
  sequence: '11', eventId, eventType: 'ad_consent_revoked',
  status: 'matched', subjectUserId: userId, resourceId: null
};

function poolWithQueries(responses = []) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('current_database()')) {
        return { rowCount: 1, rows: [{ database_name: 'vow_restore_test', database_role: 'vow_restore_runner' }] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(String(sql).trim())) {
        return { rowCount: 0, rows: [] };
      }
      return responses.shift() || { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

function stagedEvent() {
  return {
    ledger_sequence: '11', event_id: eventId, schema_version: 1,
    event_type: 'ad_consent_revoked',
    subject_ref: createHmac('sha256', key).update(userId, 'utf8').digest('hex'),
    resource_ref: null,
    occurred_at: new Date('2026-11-16T10:00:00.000Z'),
    received_at: new Date('2026-11-16T10:00:01.000Z')
  };
}

test('ad consent executor refuses production before opening a database connection', async () => {
  let connects = 0;
  await assert.rejects(
    applyAdConsentRevocationPrivacyRecoveryEvent({
      pool: { async connect() { connects += 1; throw new Error('must_not_connect'); } },
      mapping, pseudonymKey: key, env: { ...isolatedEnv, NODE_ENV: 'production' }
    }),
    /privacy_recovery_ad_consent_requires_isolated_restore/
  );
  assert.equal(connects, 0);
});

test('ad consent executor rejects a subject pseudonym mismatch before domain writes', async () => {
  const wrongMapping = { ...mapping, subjectUserId: '123e4567-e89b-42d3-a456-426614174199' };
  const { pool, calls } = poolWithQueries([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [stagedEvent()] }
  ]);
  await assert.rejects(
    applyAdConsentRevocationPrivacyRecoveryEvent({
      pool, mapping: wrongMapping, pseudonymKey: key, env: isolatedEnv
    }),
    /privacy_recovery_ad_consent_subject_mismatch/
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE ad_consent_preferences')), false);
});

test('ad consent preflight blocks missing preference state before batch writes', async () => {
  const { pool, calls } = poolWithQueries([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [stagedEvent()] },
    { rowCount: 1, rows: [{ status: 'active' }] },
    { rowCount: 0, rows: [] }
  ]);
  await assert.rejects(
    preflightAdConsentRevocationPrivacyRecovery({
      pool, mapping, pseudonymKey: key, env: isolatedEnv
    }),
    /privacy_recovery_ad_consent_preferences_missing/
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE ad_consent_preferences')), false);
});


function eventDigest(row) {
  return createHash('sha256').update(JSON.stringify([
    String(row.ledger_sequence), row.event_id, String(row.schema_version),
    row.event_type, String(row.subject_ref).toLowerCase(),
    row.resource_ref?.toLowerCase() ?? null,
    new Date(row.occurred_at).toISOString(),
    new Date(row.received_at).toISOString()
  ])).digest('hex');
}


test('existing ad-consent receipt never bypasses subject pseudonym validation', async () => {
  const staged = stagedEvent();
  const receipt = {
    ledger_sequence: mapping.sequence, event_id: eventId,
    event_digest: eventDigest(staged), event_type: mapping.eventType,
    outcome_code: 'ad_consent_revoked_fail_closed'
  };
  const wrongMapping = { ...mapping, subjectUserId: '123e4567-e89b-42d3-a456-426614174199' };
  for (const operation of [preflightAdConsentRevocationPrivacyRecovery, applyAdConsentRevocationPrivacyRecoveryEvent]) {
    const { pool, calls } = poolWithQueries([
      { rowCount: 1, rows: [receipt] },
      { rowCount: 1, rows: [staged] }
    ]);
    await assert.rejects(
      operation({ pool, mapping: wrongMapping, pseudonymKey: key, env: isolatedEnv }),
      /privacy_recovery_ad_consent_subject_mismatch/
    );
    assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
    assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
    assert.equal(calls.some(call => call.sql.includes('UPDATE ad_consent_preferences')), false);
  }
});

test('ad consent verifier refuses production before opening a database connection', async () => {
  let connects = 0;
  await assert.rejects(
    verifyAdConsentRevocationPrivacyRecovery({
      pool: { async connect() { connects += 1; throw new Error('must_not_connect'); } },
      env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 0,
      throughSequence: 12
    }),
    /privacy_recovery_ad_consent_verification_requires_isolated_restore/
  );
  assert.equal(connects, 0);
});
