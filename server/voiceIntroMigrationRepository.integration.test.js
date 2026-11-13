import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  claimNextVoiceIntroMigration,
  renewVoiceIntroMigrationLease,
  releaseVoiceIntroMigrationLease,
  transitionVoiceIntroMigrationState,
  switchVoiceIntroMigrationReference,
  completeVoiceIntroMigrationAfterRollbackWindow
} from './voiceIntroMigrationRepository.js';

const { Pool } = pg;

test('voice intro migration repository atomically claims, renews and CAS-transitions under a fenced lease', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  // These integration fixtures share a database and claim the global migration queue.
  // Serialize them so one test cannot lease another test's synthetic journal row.
  const lockClient = await pool.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtext('vow-voice-intro-migration-integration'))");
  const journalId = randomUUID();
  const introId = randomUUID();
  const userId = randomUUID();
  const sourcePath = `/private/voice/${randomUUID()}.enc`;
  const stagedPath = `/private/voice/${randomUUID()}.enc`;
  const tokenA = randomUUID();
  const tokenB = randomUUID();

  try {
    await pool.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [userId, `voice-migration-repository-${userId}@example.invalid`]
    );
    await pool.query(
      `INSERT INTO profile_voice_intros
        (id, user_id, storage_path, mime_type, byte_size, duration_ms)
       VALUES ($1, $2, $3, 'audio/mp4', 64, 15000)`,
      [introId, userId, sourcePath]
    );
    await pool.query(
      `INSERT INTO voice_intro_migration_journal
        (id, idempotency_key, voice_intro_id, source_path, source_sha256, source_format, target_key_id)
       VALUES ($1, $2, $3, $4, $5, 'VOWVOICE1', 'voice-next')`,
      [journalId, `repository-test:${journalId}`, introId, sourcePath, 'd'.repeat(64)]
    );

    const leaseA = await claimNextVoiceIntroMigration(pool, {
      workerId: 'repository-worker-a', token: tokenA, leaseDurationMs: 30_000, journalId
    });
    assert.equal(leaseA.id, journalId);
    assert.equal(Number(leaseA.lease_generation), 1);

    const competingLease = await claimNextVoiceIntroMigration(pool, {
      workerId: 'repository-worker-b', token: tokenB, leaseDurationMs: 30_000, journalId
    });
    assert.equal(competingLease, null, 'a second worker cannot claim a live lease');

    const authenticated = await transitionVoiceIntroMigrationState(pool, {
      id: journalId, token: tokenA, generation: 1,
      expectedState: 'planned', expectedVersion: 1,
      nextState: 'source_authenticated'
    });
    assert.equal(authenticated.state, 'source_authenticated');
    assert.equal(authenticated.version, 2);

    const staleVersion = await transitionVoiceIntroMigrationState(pool, {
      id: journalId, token: tokenA, generation: 1,
      expectedState: 'source_authenticated', expectedVersion: 1,
      nextState: 'staged_authenticated',
      patch: { stagedPath: '/private/voice/staging/repository.enc', stagedSha256: 'e'.repeat(64) }
    });
    assert.equal(staleVersion, null, 'a stale journal version cannot transition');

    const staged = await transitionVoiceIntroMigrationState(pool, {
      id: journalId, token: tokenA, generation: 1,
      expectedState: 'source_authenticated', expectedVersion: 2,
      nextState: 'staged_authenticated',
      patch: { stagedPath: '/private/voice/staging/repository.enc', stagedSha256: 'e'.repeat(64) }
    });
    assert.equal(staged.state, 'staged_authenticated');
    assert.equal(staged.version, 3, 'state transition succeeds while lease metadata remains unchanged');

    const renewed = await renewVoiceIntroMigrationLease(pool, {
      id: journalId, token: tokenA, generation: 1, leaseDurationMs: 30_000
    });
    assert.equal(renewed.id, journalId);

    const switched = await switchVoiceIntroMigrationReference(pool, {
      id: journalId, token: tokenA, generation: 1, expectedVersion: 3,
      voiceIntroId: introId, sourcePath, stagedPath
    });
    assert.equal(switched.state, 'reference_switched');
    const liveReference = await pool.query(
      'SELECT storage_path FROM profile_voice_intros WHERE id = $1',
      [introId]
    );
    assert.equal(liveReference.rows[0].storage_path, stagedPath);

    const released = await releaseVoiceIntroMigrationLease(pool, {
      id: journalId, token: tokenA, generation: 1
    });
    assert.equal(released.id, journalId);

    const leaseB = await claimNextVoiceIntroMigration(pool, {
      workerId: 'repository-worker-b', token: tokenB, leaseDurationMs: 30_000
    });
    assert.equal(leaseB.id, journalId);
    assert.equal(Number(leaseB.lease_generation), 2);

    const staleWorkerTransition = await transitionVoiceIntroMigrationState(pool, {
      id: journalId, token: tokenA, generation: 1,
      expectedState: 'reference_switched', expectedVersion: 4,
      nextState: 'rollback_window', patch: { rollbackWindowMs: 60_000 }
    });
    assert.equal(staleWorkerTransition, null, 'a previous lease owner is fenced after reacquisition');

    const currentTransition = await transitionVoiceIntroMigrationState(pool, {
      id: journalId, token: tokenB, generation: 2,
      expectedState: 'reference_switched', expectedVersion: 4,
      nextState: 'rollback_window', patch: { rollbackWindowMs: 60_000 }
    });
    assert.equal(currentTransition.state, 'rollback_window');
    assert.ok(new Date(currentTransition.rollback_deadline).getTime() > Date.now());

    await pool.query(
      `UPDATE voice_intro_migration_journal
       SET rollback_deadline = statement_timestamp() - INTERVAL '1 second'
       WHERE id = $1`,
      [journalId]
    );
    const completed = await completeVoiceIntroMigrationAfterRollbackWindow(pool, {
      id: journalId, token: tokenB, generation: 2, expectedVersion: 5
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.version, 6);

    const queuedSource = await pool.query(
      'SELECT storage_path FROM private_voice_intro_purge_queue WHERE storage_path = $1',
      [sourcePath]
    );
    assert.equal(queuedSource.rowCount, 1, 'old ciphertext is queued only after rollback window completion');

    const events = await pool.query(
      'SELECT version, to_state FROM voice_intro_migration_journal_events WHERE journal_id = $1 ORDER BY version',
      [journalId]
    );
    assert.deepEqual(events.rows.map(row => row.to_state), [
      'planned', 'source_authenticated', 'staged_authenticated',
      'reference_switched', 'rollback_window', 'completed'
    ]);
    assert.deepEqual(events.rows.map(row => Number(row.version)), [1, 2, 3, 4, 5, 6]);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('vow-voice-intro-migration-integration'))");
    lockClient.release();
    await pool.end();
  }
});
