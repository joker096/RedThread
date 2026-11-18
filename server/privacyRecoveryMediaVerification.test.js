import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  resource_id: '123e4567-e89b-42d3-a456-426614174002',
  purge_count: 1
};
let storagePath;
let pathDigest;
let physicalRoot;
const storageRoots = {};
before(async () => {
  physicalRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-physical-purge-'));
  for (const key of ['photo', 'voice', 'identityL3']) {
    storageRoots[key] = path.join(physicalRoot, key);
    await mkdir(storageRoots[key], { mode: 0o700 });
  }
  storagePath = path.join(storageRoots.photo, event.resource_id + '.jpg');
  pathDigest = createHash('sha256').update(storagePath).digest('hex');
});
after(async () => {
  if (physicalRoot) await rm(physicalRoot, { recursive: true, force: true });
});

const isolatedEnv = { NODE_ENV: 'test', PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true', PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test', PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner', PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY' };

function verify(args) { return verifyPrivateMediaPrivacyRecovery({ ...args, storageRoots }); }

function makePool({ receiptRows = [event], obligations = [{
  ledger_sequence: '7', queue_name: 'private_photo', storage_path_sha256: pathDigest
}], queuePaths = [], completionRows = [{ ledger_sequence: '7', queue_name: 'private_photo', storage_path_sha256: pathDigest }], remainingPhotos = [], profiles = [{ user_id: event.subject_user_id, photo_urls: [] }], l3ConsentRows = [{ withdrawn_at: new Date('2026-11-18T00:00:00.000Z') }], l3TokenRows = [], l3SubmissionRows = [], l3PurgeJobRows = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN TRANSACTION')) return { rows: [] };
      if (sql.includes('current_database()')) return { rows: [{ database_name: 'vow_restore_test', database_role: 'vow_restore_runner' }] };
      if (sql.includes('FROM privacy_recovery_events e')) return { rows: receiptRows };
      if (sql.includes('FROM photo_assets')) return { rows: remainingPhotos };
      if (sql.includes('FROM profiles')) return { rows: profiles, rowCount: profiles.length };
      if (sql.includes('FROM privacy_recovery_replay_purge_obligations')) return { rows: obligations };
      if (sql.includes('FROM privacy_recovery_replay_purge_completions')) return { rows: completionRows };
      if (sql.includes('FROM private_photo_purge_queue')) return { rows: queuePaths.map(storage_path => ({ storage_path })) };
      if (sql.includes('FROM private_voice_intro_purge_queue')) return { rows: [] };
      if (sql.includes('FROM identity_l3_consents')) return { rows: l3ConsentRows, rowCount: l3ConsentRows.length };
      if (sql.includes('FROM identity_l3_upload_tokens')) return { rows: l3TokenRows };
      if (sql.includes('FROM identity_l3_submissions')) return { rows: l3SubmissionRows };
      if (sql.includes('FROM identity_l3_media_purge_jobs')) return { rows: l3PurgeJobRows };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('unexpected_query');
    },
    release() { calls.push('RELEASE'); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

test('post-replay verification confirms receipt, deleted metadata, hidden photo URL and completed physical purge receipt', async () => {
  const { pool, calls } = makePool();
  const result = await verify({
    pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7
  });
  assert.deepEqual(result, {
    complete: true,
    verifiedEventCount: 1,
    verifiedPhotoErasureCount: 1,
    verifiedVoiceErasureCount: 0,
    verifiedVoiceConsentWithdrawalCount: 0,
    verifiedPurgeObligationCount: 1,
    verifiedPurgeCompletionCount: 1,
    verifiedPhotoObjectAbsenceCount: 1,
    verifiedVoiceObjectAbsenceCount: 0,
    verifiedIdentityL3ObjectAbsenceCount: 0,
    throughSequence: 7
  });
  assert.equal(calls.includes('COMMIT'), true);
});

test('verification rejects a partially populated purge obligation set even when the queue is empty', async () => {
  const { pool, calls } = makePool({ obligations: [], queuePaths: [], completionRows: [] });
  await assert.rejects(
    verify({ pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_purge_obligation_missing/
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});

test('verification fails closed when a purge obligation has no immutable completion receipt', async () => {
  const { pool, calls } = makePool({ completionRows: [] });
  await assert.rejects(
    verify({ pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_purge_completion_missing/
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});


test('verification refuses activation while a purge obligation remains in the operational queue', async () => {
  const { pool, calls } = makePool({ queuePaths: [storagePath] });
  await assert.rejects(
    verify({ pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_purge_still_queued/
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});

test('verification rejects a missing receipt or changed event digest', async () => {
  const missingReceipt = { ...event, event_digest: null, receipt_event_type: null, outcome_code: null };
  const { pool } = makePool({ receiptRows: [missingReceipt] });
  await assert.rejects(
    verify({ pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_receipt_mismatch/
  );
});

test('verification rejects remaining photo metadata and stale profile visibility', async () => {
  const { pool: remainingPool } = makePool({ remainingPhotos: [{ id: event.resource_id }] });
  await assert.rejects(
    verify({ pool: remainingPool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_photo_metadata_remains/
  );
  const { pool: staleUrlPool } = makePool({
    profiles: [{ user_id: event.subject_user_id, photo_urls: ['/api/photos/' + event.resource_id] }]
  });
  await assert.rejects(
    verify({ pool: staleUrlPool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7 }),
    /privacy_recovery_verification_photo_visibility_remains/
  );
});

function makeL3Event(purgeCount) {
  const l3Event = {
    ...event,
    event_type: 'identity_l3_consent_withdrawn',
    resource_ref: null,
    receipt_event_type: 'identity_l3_consent_withdrawn',
    effect_event_type: 'identity_l3_consent_withdrawn',
    event_digest: createHash('sha256').update(JSON.stringify([
      '7', event.event_id, '1', 'identity_l3_consent_withdrawn',
      event.subject_ref, null, event.occurred_at.toISOString(), event.received_at.toISOString()
    ])).digest('hex'),
    outcome_code: 'identity_l3_consent_withdrawn',
    resource_id: null,
    purge_count: purgeCount
  };
  return l3Event;
}

test('L3 verification accepts zero retained media purge obligations', async () => {
  const l3Event = makeL3Event(0);
  const { pool, calls } = makePool({
    receiptRows: [l3Event],
    obligations: [],
    completionRows: [],
    profiles: [],
    l3ConsentRows: [{ withdrawn_at: new Date('2026-11-18T00:00:00.000Z') }]
  });
  const result = await verify({
    pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7
  });
  assert.equal(result.complete, true);
  assert.equal(result.verifiedEventCount, 1);
  assert.equal(result.verifiedPurgeObligationCount, 0);
  assert.equal(result.verifiedPurgeCompletionCount, 0);
  assert.equal(result.verifiedIdentityL3ObjectAbsenceCount, 0);
  assert.equal(calls.includes('COMMIT'), true);
});

test('L3 verification accepts multiple purge obligations and matching completion receipts', async () => {
  const l3Event = makeL3Event(2);
  const obligations = [
    { ledger_sequence: '7', queue_name: 'identity_l3_media', storage_path_sha256: 'c'.repeat(64) },
    { ledger_sequence: '7', queue_name: 'identity_l3_media', storage_path_sha256: 'd'.repeat(64) }
  ];
  const { pool, calls } = makePool({
    receiptRows: [l3Event],
    obligations,
    completionRows: obligations,
    profiles: [],
    l3ConsentRows: [{ withdrawn_at: new Date('2026-11-18T00:00:00.000Z') }]
  });
  const result = await verify({
    pool, env: isolatedEnv, snapshotLedgerSequence: 6, throughSequence: 7
  });
  assert.equal(result.complete, true);
  assert.equal(result.verifiedPurgeObligationCount, 2);
  assert.equal(result.verifiedPurgeCompletionCount, 2);
  assert.equal(result.verifiedIdentityL3ObjectAbsenceCount, 2);
  assert.equal(calls.includes('COMMIT'), true);
});

test('verification is restricted to explicitly isolated non-production restores', async () => {
  const { pool, calls } = makePool();
  await assert.rejects(
    verify({
      pool, env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 6, throughSequence: 7
    }),
    /privacy_recovery_verification_requires_isolated_restore/
  );
  assert.equal(calls.length, 0);
});
