import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  applyGiftConsentWithdrawalPrivacyRecoveryEvent,
  preflightGiftConsentWithdrawalPrivacyRecovery
} from './privacyRecoveryGiftConsentExecutor.js';
import { verifyGiftConsentWithdrawalPrivacyRecovery } from './privacyRecoveryGiftConsentVerification.js';

const recipientId = '123e4567-e89b-42d3-a456-426614174200';
const senderId = '123e4567-e89b-42d3-a456-426614174201';
const orderId = '123e4567-e89b-42d3-a456-426614174202';
const eventId = '123e4567-e89b-42d3-a456-426614174203';
const key = 'gift-consent-recovery-test-key-material-long-enough';
const isolatedEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: key,
  PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test',
  PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner',
  PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY'
};
const mapping = {
  sequence: '12', eventId, eventType: 'gift_order_consent_withdrawn',
  status: 'matched', subjectUserId: recipientId, resourceId: orderId
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
      if (String(sql).includes('pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
      return responses.shift() || { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

function stagedEvent() {
  return {
    ledger_sequence: '12', event_id: eventId, schema_version: 1,
    event_type: 'gift_order_consent_withdrawn',
    subject_ref: createHmac('sha256', key).update(recipientId, 'utf8').digest('hex'),
    resource_ref: createHmac('sha256', key).update(orderId, 'utf8').digest('hex'),
    occurred_at: new Date('2026-11-16T10:00:00.000Z'),
    received_at: new Date('2026-11-16T10:00:01.000Z')
  };
}

test('gift consent executor refuses production before opening a database connection', async () => {
  let connects = 0;
  await assert.rejects(
    applyGiftConsentWithdrawalPrivacyRecoveryEvent({
      pool: { async connect() { connects += 1; throw new Error('must_not_connect'); } },
      mapping, pseudonymKey: key, env: { ...isolatedEnv, NODE_ENV: 'production' }
    }),
    /privacy_recovery_gift_consent_requires_isolated_restore/
  );
  assert.equal(connects, 0);
});

test('gift consent executor rejects subject or resource pseudonym mismatch before domain writes', async () => {
  const wrongMapping = { ...mapping, resourceId: senderId };
  const { pool, calls } = poolWithQueries([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [stagedEvent()] }
  ]);
  await assert.rejects(
    applyGiftConsentWithdrawalPrivacyRecoveryEvent({
      pool, mapping: wrongMapping, pseudonymKey: key, env: isolatedEnv
    }),
    /privacy_recovery_gift_consent_mapping_mismatch/
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE gift_delivery_orders')), false);
});

test('gift consent preflight blocks dispatched or paid orders before batch writes', async () => {
  const { pool, calls } = poolWithQueries([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [stagedEvent()] },
    { rowCount: 1, rows: [{ sender_id: senderId, recipient_id: recipientId }] },
    { rowCount: 2, rows: [{ id: senderId, status: 'active' }, { id: recipientId, status: 'active' }] },
    { rowCount: 1, rows: [{
      id: orderId, sender_id: senderId, recipient_id: recipientId,
      status: 'dispatched', paymentStatus: 'captured',
      consentWithdrawnAt: null, dispatchedAt: new Date(), public_reference: 'gift_' + 'a'.repeat(32)
    }] }
  ]);
  await assert.rejects(
    preflightGiftConsentWithdrawalPrivacyRecovery({
      pool, mapping, pseudonymKey: key, env: isolatedEnv
    }),
    /privacy_recovery_gift_consent_order_not_withdrawable/
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE gift_delivery_orders')), false);
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


test('existing gift-consent receipt never bypasses subject or resource pseudonym validation', async () => {
  const staged = stagedEvent();
  const receipt = {
    ledger_sequence: mapping.sequence, event_id: eventId,
    event_digest: eventDigest(staged), event_type: mapping.eventType,
    outcome_code: 'gift_order_consent_withdrawn'
  };
  const wrongMappings = [
    { ...mapping, subjectUserId: senderId },
    { ...mapping, resourceId: senderId }
  ];
  for (const wrongMapping of wrongMappings) {
    for (const operation of [preflightGiftConsentWithdrawalPrivacyRecovery, applyGiftConsentWithdrawalPrivacyRecoveryEvent]) {
      const { pool, calls } = poolWithQueries([
        { rowCount: 1, rows: [receipt] },
        { rowCount: 1, rows: [staged] }
      ]);
      await assert.rejects(
        operation({ pool, mapping: wrongMapping, pseudonymKey: key, env: isolatedEnv }),
        /privacy_recovery_gift_consent_mapping_mismatch/
      );
      assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
      assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
      assert.equal(calls.some(call => call.sql.includes('UPDATE gift_delivery_orders')), false);
    }
  }
});

test('gift consent verifier refuses production before opening a database connection', async () => {
  let connects = 0;
  await assert.rejects(
    verifyGiftConsentWithdrawalPrivacyRecovery({
      pool: { async connect() { connects += 1; throw new Error('must_not_connect'); } },
      env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 0,
      throughSequence: 12
    }),
    /privacy_recovery_gift_consent_verification_requires_isolated_restore/
  );
  assert.equal(connects, 0);
});
