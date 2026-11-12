import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('direct account tombstoning queues voice intro bytes before deleting metadata', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const userId = randomUUID();
  const voiceId = randomUUID();
  const storagePath = `/srv/vow/private-voice-intros/${randomUUID()}.enc`;
  try {
    const trigger = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger
         WHERE tgname = 'users_queue_deleted_profile_voice_intro_purge'
           AND NOT tgisinternal
       ) AS installed`
    );
    assert.equal(trigger.rows[0].installed, true, 'account-deletion voice purge trigger must be installed');

    await client.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [userId, `voice-delete-${userId}@example.invalid`]
    );
    await client.query(
      `INSERT INTO profile_voice_intros
         (id, user_id, storage_path, mime_type, byte_size, duration_ms)
       VALUES ($1, $2, $3, 'audio/mp4', 128, 20000)`,
      [voiceId, userId, storagePath]
    );

    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]);

    const metadata = await client.query(
      'SELECT id FROM profile_voice_intros WHERE user_id = $1',
      [userId]
    );
    assert.equal(metadata.rowCount, 0, 'voice metadata must be removed on tombstoning');

    const queued = await client.query(
      'SELECT storage_path, attempts, next_attempt_at FROM private_voice_intro_purge_queue WHERE storage_path = $1',
      [storagePath]
    );
    assert.equal(queued.rowCount, 1, 'encrypted file path must be durably queued');
    assert.equal(queued.rows[0].attempts, 0);
    assert.ok(queued.rows[0].next_attempt_at instanceof Date);
  } finally {
    await client.query('DELETE FROM private_voice_intro_purge_queue WHERE storage_path = $1', [storagePath]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    client.release();
    await pool.end();
  }
});
