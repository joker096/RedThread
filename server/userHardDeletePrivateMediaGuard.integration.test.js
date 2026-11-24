import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('physical user deletion cannot cascade private media metadata before tombstone purge queues are written', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const photoUserId = randomUUID();
  const voiceUserId = randomUUID();
  const photoPath = `/srv/vow/private-photos/${randomUUID()}.jpg`;
  const voicePath = `/srv/vow/private-voice-intros/${randomUUID()}.enc`;

  try {
    const constraints = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conrelid IN ('photo_assets'::regclass, 'profile_voice_intros'::regclass)
          AND conname IN ('photo_assets_user_id_fkey', 'profile_voice_intros_user_id_fkey')
        ORDER BY conname`
    );
    assert.deepEqual(
      constraints.rows,
      [
        { conname: 'photo_assets_user_id_fkey', confdeltype: 'r' },
        { conname: 'profile_voice_intros_user_id_fkey', confdeltype: 'r' }
      ],
      'private media ownership FKs must use ON DELETE RESTRICT'
    );

    await client.query(
      `INSERT INTO users (id, email, password_hash, status)
       VALUES ($1, $2, 'test-only-hash', 'active'),
              ($3, $4, 'test-only-hash', 'active')`,
      [
        photoUserId, `photo-hard-delete-${photoUserId}@example.invalid`,
        voiceUserId, `voice-hard-delete-${voiceUserId}@example.invalid`
      ]
    );
    await client.query(
      `INSERT INTO photo_assets
         (user_id, storage_path, mime_type, byte_size, width, height)
       VALUES ($1, $2, 'image/jpeg', 128, 1, 1)`,
      [photoUserId, photoPath]
    );
    await client.query(
      `INSERT INTO profile_voice_intros
         (user_id, storage_path, mime_type, byte_size, duration_ms)
       VALUES ($1, $2, 'audio/mp4', 128, 20000)`,
      [voiceUserId, voicePath]
    );

    for (const userId of [photoUserId, voiceUserId]) {
      await client.query('SAVEPOINT before_rejected_hard_delete');
      await assert.rejects(
        client.query('DELETE FROM users WHERE id = $1', [userId]),
        error => error.code === '23503',
        'physical deletion must not cascade private media metadata'
      );
      await client.query('ROLLBACK TO SAVEPOINT before_rejected_hard_delete');
      await client.query('RELEASE SAVEPOINT before_rejected_hard_delete');
    }

    const retained = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM photo_assets WHERE user_id = $1) AS photos,
         (SELECT COUNT(*)::int FROM profile_voice_intros WHERE user_id = $2) AS voice_intros`,
      [photoUserId, voiceUserId]
    );
    assert.deepEqual(retained.rows[0], { photos: 1, voice_intros: 1 });

    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [photoUserId]);
    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [voiceUserId]);

    const queued = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM private_photo_purge_queue WHERE storage_path = $1) AS photos,
         (SELECT COUNT(*)::int FROM private_voice_intro_purge_queue WHERE storage_path = $2) AS voice_intros,
         (SELECT COUNT(*)::int FROM photo_assets WHERE user_id = $3) AS photo_metadata,
         (SELECT COUNT(*)::int FROM profile_voice_intros WHERE user_id = $4) AS voice_metadata`,
      [photoPath, voicePath, photoUserId, voiceUserId]
    );
    assert.deepEqual(queued.rows[0], {
      photos: 1,
      voice_intros: 1,
      photo_metadata: 0,
      voice_metadata: 0
    }, 'tombstoning must queue physical deletion before removing media metadata');

    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[photoUserId, voiceUserId]]);
  } finally {
    await client.query('DELETE FROM photo_assets WHERE user_id = ANY($1::uuid[])', [[photoUserId, voiceUserId]]).catch(() => {});
    await client.query('DELETE FROM profile_voice_intros WHERE user_id = ANY($1::uuid[])', [[photoUserId, voiceUserId]]).catch(() => {});
    await client.query('DELETE FROM private_photo_purge_queue WHERE storage_path = $1', [photoPath]).catch(() => {});
    await client.query('DELETE FROM private_voice_intro_purge_queue WHERE storage_path = $1', [voicePath]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[photoUserId, voiceUserId]]).catch(() => {});
    client.release();
    await pool.end();
  }
});
