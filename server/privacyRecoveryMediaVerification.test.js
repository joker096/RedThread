import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPrivateMediaPrivacyRecovery } from './privacyRecoveryMediaVerification.js';

const event = {
  ledger_sequence: '7',
  event_id: '123e4567-e89b-42d3-a456-426614174007',
  schema_version: 1,
  event_type: 'private_photo_erasure_requested',
  subject_ref: 'a'.repeat(64),
  resource_ref: 'b'.repeat(64),
  occurred_at: new Date('2026-11-14T08:00:00.000Z'),
  received_at: new Date('2026-11-14T08:00:01.000Z'),
  receipt_event_type: 'private_photo_erasure_requested',
  effect_event_type: 'private_photo_erasure_requested',
  event_digest: createHash('sha256').update(JSON.stringify([
    '7', '123e4567-e89b-42d3-a456-426614174007', '1',
    'private_photo_erasure_requested', 'a'.repeat(64), 'b'.repeat(64),
    '2026-11-14T08:00:00.000Z', '2026-11-14T08:00:01.000Z'
  ])).digest('hex'),
  outcome_code: 'photo_erasure_queued',
  subject_user_id: '123e4567-e89b-42d3-a456-426614174001',
  resource_id: '123e4567-e89b-42d3-a456-426614174002'
};
const storagePath = '/private/photos/123e4567-e89b-42d3-a456-426614174002.jpg';
const pathDigest = createHash('sha256').update(storagePath).digest('hex');
const isolatedEnv = { NODE_ENV: 'test', PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true' };

function makePool({ receiptRows = [event], obligations = [{
  ledger_sequence: '7', queue_name: 'private_photo', storage_path_sha256: pathDigest
}], queuePaths = [storagePath], remainingPhotos = [], profiles = [{ user_id: event.subject_user_id, photo_urls: [] }] } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN TRANSACTION')) return { rows: [] };
      if (sql.includes('FROM privacy_recovery_events e')) return { rows: receiptRows };
      if (sql.includes('FROM photo_assets')) return { rows: remainingPhotos };
      if (sql.includes('FROM profiles')) return { rows: profiles, rowCount: profiles.length };
      if (sql.includes('FROM privacy_recovery_replay_purge_obligations')) return { rows: obligations };
      if (sql.includes('FROM private_photo_purge_queue')) return { rows: queuePaths.map(storage_path => ({ storage_path })) };
      if (sql.includes('FROM private_voice_intro_purge_queue')) return { rows: [] };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('unexpected_query');
    },
    release() { calls.push('RELEASE'); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

test('post-replay verification confirms receipt, deleted metadata, hidden photo URL and queued purge obligation', async () => {
  const { pool, calls } = makePool();
  const result = await verifyPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7
  });
  assert.deepEqual(result, {
    complete: true,
    verifiedEventCount: 1,
    verifiedPhotoErasureCount: 1,
    verifiedVoiceErasureCount: 0,
    verifiedVoiceConsentWithdrawalCount: 0,
    verifiedPurgeObligationCount: 1,
    throughSequence: 7
  });
  assert.equal(calls.includes('COMMIT'), true);
});

test('verification fails closed when purge queue obligation is missing', async () => {
  const { pool, calls } = makePool({ queuePaths: [] });
  await assert.rejects(
    verifyPrivateMediaPrivacyRecovery({ pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_purge_obligation_missing/
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});

test('verification rejects a missing receipt or changed event digest', async () => {
  const missingReceipt = { ...event, event_digest: null, receipt_event_type: null, outcome_code: null };
  const { pool } = makePool({ receiptRows: [missingReceipt] });
  await assert.rejects(
    verifyPrivateMediaPrivacyRecovery({ pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_receipt_mismatch/
  );
});

test('verification rejects remaining photo metadata and stale profile visibility', async () => {
  const { pool: remainingPool } = makePool({ remainingPhotos: [{ id: event.resource_id }] });
  await assert.rejects(
    verifyPrivateMediaPrivacyRecovery({ pool: remainingPool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_photo_metadata_remains/
  );
  const { pool: staleUrlPool } = makePool({
    profiles: [{ user_id: event.subject_user_id, photo_urls: ['/api/photos/' + event.resource_id] }]
  });
  await assert.rejects(
    verifyPrivateMediaPrivacyRecovery({ pool: staleUrlPool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_photo_visibility_remains/
  );
});

test('verification is restricted to explicitly isolated non-production restores', async () => {
  const { pool, calls } = makePool();
  await assert.rejects(
    verifyPrivateMediaPrivacyRecovery({
      pool, env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 6, throughSequence: 7
    }),
    /privacy_recovery_verification_requires_isolated_restore/
  );
  assert.equal(calls.length, 0);
});
