import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encryptVoiceIntro, decryptVoiceIntro } from './voiceIntroStorage.js';
import { processNextVoiceIntroMigration } from './voiceIntroMigrationWorker.js';

const { Pool } = pg;
const digest = value => createHash('sha256').update(value).digest('hex');

test('voice migration worker stages, switches atomically and defers source purge until rollback window ends', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  // These integration fixtures share a database and claim the global migration queue.
  // Serialize them so one test cannot lease another test's synthetic journal row.
  const lockClient = await pool.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtext('vow-voice-intro-migration-integration'))");
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-worker-'));
  await chmod(root, 0o700);
  const userId = randomUUID();
  const introId = randomUUID();
  const journalId = randomUUID();
  const sourcePath = path.join(root, randomUUID() + '.enc');
  const legacyKey = Buffer.alloc(32, 11);
  const targetKey = Buffer.alloc(32, 12);
  const plaintext = Buffer.from('voice worker private encrypted fixture payload');
  const sourceCiphertext = encryptVoiceIntro(plaintext, legacyKey);
  const keyring = {
    activeKeyId: 'voice-next',
    keys: new Map([['voice-old', legacyKey], ['voice-next', targetKey]]),
    legacyKey
  };

  try {
    await writeFile(sourcePath, sourceCiphertext, { mode: 0o600 });
    await pool.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [userId, `voice-migration-worker-${userId}@example.invalid`]
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
      [journalId, `worker-test:${journalId}`, introId, sourcePath, digest(sourceCiphertext)]
    );

    const first = await processNextVoiceIntroMigration(pool, {
      workerId: 'integration-worker-a',
      storageRoot: root,
      keyring,
      rollbackWindowMs: 60_000
    });
    assert.deepEqual(first, { status: 'rollback_window' });

    const afterSwitch = await pool.query(
      `SELECT j.state, j.version, j.staged_path, j.staged_sha256,
              p.storage_path, j.rollback_deadline
       FROM voice_intro_migration_journal j
       JOIN profile_voice_intros p ON p.id = j.voice_intro_id
       WHERE j.id = $1`,
      [journalId]
    );
    assert.equal(afterSwitch.rows[0].state, 'rollback_window');
    assert.equal(afterSwitch.rows[0].storage_path, afterSwitch.rows[0].staged_path);
    assert.notEqual(afterSwitch.rows[0].storage_path, sourcePath);

    const stagedCiphertext = await readFile(afterSwitch.rows[0].staged_path);
    assert.equal(stagedCiphertext.subarray(0, 9).toString('utf8'), 'VOWVOICE2');
    assert.deepEqual(decryptVoiceIntro(stagedCiphertext, keyring), plaintext);

    const sourceStillExists = await readFile(sourcePath);
    assert.deepEqual(sourceStillExists, sourceCiphertext, 'source is retained throughout rollback window');

    await pool.query(
      `UPDATE voice_intro_migration_journal
       SET rollback_deadline = statement_timestamp() - INTERVAL '1 second'
       WHERE id = $1`,
      [journalId]
    );
    const second = await processNextVoiceIntroMigration(pool, {
      workerId: 'integration-worker-b',
      storageRoot: root,
      keyring,
      rollbackWindowMs: 60_000
    });
    assert.equal(second.status, 'completed');

    const completed = await pool.query(
      'SELECT state, version FROM voice_intro_migration_journal WHERE id = $1',
      [journalId]
    );
    assert.deepEqual(completed.rows[0], { state: 'completed', version: 6 });

    const queued = await pool.query(
      'SELECT storage_path FROM private_voice_intro_purge_queue WHERE storage_path = $1',
      [sourcePath]
    );
    assert.equal(queued.rowCount, 1);
  } finally {
    try {
      await pool.query('DELETE FROM private_voice_intro_purge_queue WHERE storage_path = $1', [sourcePath]);
      await pool.query('DELETE FROM voice_intro_migration_journal_events WHERE journal_id = $1', [journalId]);
      await pool.query('DELETE FROM voice_intro_migration_journal WHERE id = $1', [journalId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    } catch {}
    plaintext.fill(0);
    sourceCiphertext.fill(0);
    legacyKey.fill(0);
    targetKey.fill(0);
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('vow-voice-intro-migration-integration'))");
    lockClient.release();
    await pool.end();
    await rm(root, { recursive: true, force: true });
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('vow-voice-intro-migration-integration'))");
    lockClient.release();
    await pool.end();
  }
});


test('voice migration worker restores the source reference and queues corrupt staged ciphertext', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  // Share the same queue lock with the repository integration test.
  const lockClient = await pool.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtext('vow-voice-intro-migration-integration'))");
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-rollback-'));
  await chmod(root, 0o700);
  const userId = randomUUID();
  const introId = randomUUID();
  const journalId = randomUUID();
  const sourcePath = path.join(root, randomUUID() + '.enc');
  const legacyKey = Buffer.alloc(32, 21);
  const targetKey = Buffer.alloc(32, 22);
  const plaintext = Buffer.from('rollback fixture private audio bytes');
  const sourceCiphertext = encryptVoiceIntro(plaintext, legacyKey);
  const keyring = {
    activeKeyId: 'voice-next',
    keys: new Map([['voice-old', legacyKey], ['voice-next', targetKey]]),
    legacyKey
  };
  let stagedPath;

  try {
    await writeFile(sourcePath, sourceCiphertext, { mode: 0o600 });
    await pool.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [userId, `voice-migration-rollback-${userId}@example.invalid`]
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
      [journalId, `rollback-test:${journalId}`, introId, sourcePath, digest(sourceCiphertext)]
    );

    const first = await processNextVoiceIntroMigration(pool, {
      workerId: 'rollback-worker-a',
      storageRoot: root,
      keyring,
      rollbackWindowMs: 60_000
    });
    assert.equal(first.status, 'rollback_window');

    const row = await pool.query(
      'SELECT staged_path FROM voice_intro_migration_journal WHERE id = $1',
      [journalId]
    );
    stagedPath = row.rows[0].staged_path;
    const damaged = await readFile(stagedPath);
    damaged[damaged.length - 1] ^= 0x40;
    await writeFile(stagedPath, damaged, { mode: 0o600 });

    const second = await processNextVoiceIntroMigration(pool, {
      workerId: 'rollback-worker-b',
      storageRoot: root,
      keyring,
      rollbackWindowMs: 60_000
    });
    assert.deepEqual(second, { status: 'rolled_back' });

    const restored = await pool.query(
      `SELECT j.state, p.storage_path
       FROM voice_intro_migration_journal j
       JOIN profile_voice_intros p ON p.id = j.voice_intro_id
       WHERE j.id = $1`,
      [journalId]
    );
    assert.equal(restored.rows[0].state, 'rolled_back');
    assert.equal(restored.rows[0].storage_path, sourcePath);

    const queuedStage = await pool.query(
      'SELECT storage_path FROM private_voice_intro_purge_queue WHERE storage_path = $1',
      [stagedPath]
    );
    assert.equal(queuedStage.rowCount, 1, 'corrupt staged ciphertext is queued for deletion');
  } finally {
    try {
      if (stagedPath) await pool.query('DELETE FROM private_voice_intro_purge_queue WHERE storage_path = $1', [stagedPath]);
      await pool.query('DELETE FROM voice_intro_migration_journal_events WHERE journal_id = $1', [journalId]);
      await pool.query('DELETE FROM voice_intro_migration_journal WHERE id = $1', [journalId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    } catch {}
    plaintext.fill(0);
    sourceCiphertext.fill(0);
    legacyKey.fill(0);
    targetKey.fill(0);
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
