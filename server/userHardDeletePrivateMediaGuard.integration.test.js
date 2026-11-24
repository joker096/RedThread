import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('physical user/provider deletion cannot cascade private object metadata before purge queues are written', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const photoUserId = randomUUID();
  const voiceUserId = randomUUID();
  const providerUserId = randomUUID();
  const providerId = randomUUID();
  const documentId = randomUUID();
  const photoPath = `/srv/vow/private-photos/${randomUUID()}.jpg`;
  const voicePath = `/srv/vow/private-voice-intros/${randomUUID()}.enc`;
  const providerStorageKey = `private/provider-verification/${randomUUID()}.enc`;

  try {
    await client.query('BEGIN');
    const constraints = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conrelid IN ('photo_assets'::regclass, 'profile_voice_intros'::regclass,
                           'partner_providers'::regclass, 'provider_verification_documents'::regclass)
          AND conname IN ('photo_assets_user_id_fkey', 'profile_voice_intros_user_id_fkey',
                          'partner_providers_user_id_fkey', 'provider_verification_documents_provider_id_fkey')
        ORDER BY conname`
    );
    assert.deepEqual(constraints.rows, [
      { conname: 'partner_providers_user_id_fkey', confdeltype: 'r' },
      { conname: 'photo_assets_user_id_fkey', confdeltype: 'r' },
      { conname: 'profile_voice_intros_user_id_fkey', confdeltype: 'r' },
      { conname: 'provider_verification_documents_provider_id_fkey', confdeltype: 'r' }
    ], 'all private-object ownership FKs must use ON DELETE RESTRICT');

    await client.query(
      `INSERT INTO users (id, email, password_hash, status)
       VALUES ($1, $2, 'test-only-hash', 'active'),
              ($3, $4, 'test-only-hash', 'active'),
              ($5, $6, 'test-only-hash', 'active')`,
      [
        photoUserId, `photo-hard-delete-${photoUserId}@example.invalid`,
        voiceUserId, `voice-hard-delete-${voiceUserId}@example.invalid`,
        providerUserId, `provider-hard-delete-${providerUserId}@example.invalid`
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
    await client.query(
      `INSERT INTO partner_providers (id, user_id, category, business_name, country, city)
       VALUES ($1, $2, 'photography', 'Test Provider', 'Georgia', 'Tbilisi')`,
      [providerId, providerUserId]
    );
    await client.query(
      `INSERT INTO provider_verification_documents (id, provider_id, document_type, private_storage_key)
       VALUES ($1, $2, 'identity', $3)`,
      [documentId, providerId, providerStorageKey]
    );

    for (const userId of [photoUserId, voiceUserId, providerUserId]) {
      await client.query('SAVEPOINT before_rejected_hard_delete');
      await assert.rejects(
        client.query('DELETE FROM users WHERE id = $1', [userId]),
        error => error.code === '23503',
        'physical user deletion must not cascade private object metadata'
      );
      await client.query('ROLLBACK TO SAVEPOINT before_rejected_hard_delete');
      await client.query('RELEASE SAVEPOINT before_rejected_hard_delete');
    }

    await client.query('SAVEPOINT before_rejected_provider_delete');
    await assert.rejects(
      client.query('DELETE FROM partner_providers WHERE id = $1', [providerId]),
      error => error.code === '23503',
      'provider deletion must not cascade private verification document metadata'
    );
    await client.query('ROLLBACK TO SAVEPOINT before_rejected_provider_delete');
    await client.query('RELEASE SAVEPOINT before_rejected_provider_delete');

    const retained = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM photo_assets WHERE user_id = $1) AS photos,
         (SELECT COUNT(*)::int FROM profile_voice_intros WHERE user_id = $2) AS voice_intros,
         (SELECT COUNT(*)::int FROM provider_verification_documents WHERE id = $3) AS provider_documents`,
      [photoUserId, voiceUserId, documentId]
    );
    assert.deepEqual(retained.rows[0], { photos: 1, voice_intros: 1, provider_documents: 1 });

    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [photoUserId]);
    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [voiceUserId]);
    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [providerUserId]);

    const queued = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM private_photo_purge_queue WHERE storage_path = $1) AS photos,
         (SELECT COUNT(*)::int FROM private_voice_intro_purge_queue WHERE storage_path = $2) AS voice_intros,
         (SELECT COUNT(*)::int FROM photo_assets WHERE user_id = $3) AS photo_metadata,
         (SELECT COUNT(*)::int FROM profile_voice_intros WHERE user_id = $4) AS voice_metadata,
         (SELECT COUNT(*)::int FROM provider_verification_documents WHERE id = $5) AS provider_documents`,
      [photoPath, voicePath, photoUserId, voiceUserId, documentId]
    );
    assert.deepEqual(queued.rows[0], {
      photos: 1,
      voice_intros: 1,
      photo_metadata: 0,
      voice_metadata: 0,
      provider_documents: 1
    }, 'tombstoning queues photo/voice deletion while retaining provider docs without a purge workflow');

    await client.query('DELETE FROM provider_verification_documents WHERE id = $1', [documentId]);
    await client.query('DELETE FROM partner_providers WHERE id = $1', [providerId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[photoUserId, voiceUserId, providerUserId]]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query('DELETE FROM photo_assets WHERE user_id = ANY($1::uuid[])', [[photoUserId, voiceUserId, providerUserId]]).catch(() => {});
    await client.query('DELETE FROM profile_voice_intros WHERE user_id = ANY($1::uuid[])', [[photoUserId, voiceUserId, providerUserId]]).catch(() => {});
    await client.query('DELETE FROM provider_verification_documents WHERE id = $1', [documentId]).catch(() => {});
    await client.query('DELETE FROM partner_providers WHERE id = $1', [providerId]).catch(() => {});
    await client.query('DELETE FROM private_photo_purge_queue WHERE storage_path = $1', [photoPath]).catch(() => {});
    await client.query('DELETE FROM private_voice_intro_purge_queue WHERE storage_path = $1', [voicePath]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[photoUserId, voiceUserId, providerUserId]]).catch(() => {});
    client.release();
    await pool.end();
  }
});
