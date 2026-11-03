import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { purgeDeletedAccountL3SubmissionMetadata } from './process-identity-l3-queue.js';

const { Pool } = pg;

test('account deletion scrubs profile personal data in the database', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const email = `deleted-profile-${randomUUID()}@example.invalid`;
  const phoneE164 = '+1' + BigInt('0x' + randomUUID().replace(/-/g, '')).toString().slice(0, 10);
  let userId;
  try {
    await client.query('BEGIN');
    const user = await client.query(
      "INSERT INTO users (email, password_hash, phone_e164, phone_verified_at, status) VALUES ($1, 'test-only-hash', $2, statement_timestamp(), 'active') RETURNING id",
      [email, phoneE164]
    );
    userId = user.rows[0].id;
    await client.query(
      `INSERT INTO profiles
         (user_id, display_name, birth_date, gender, country, city, bio, relationship_intent,
          is_visible, photo_urls, occupation, education, languages, family_format,
          has_children, children_disclosure_confirmed_at, wants_children,
          children_living_arrangement, family_values)
       VALUES ($1, 'Profile Name', DATE '1990-01-02', 'female', 'Georgia', 'Tbilisi',
          'Profile biography', 'family_without_marriage', TRUE, ARRAY['/api/photos/secret'],
          'Occupation', 'Education', ARRAY['ka', 'ru'], 'marriage',
          TRUE, statement_timestamp(), 'yes', 'with_me', ARRAY['value-a', 'value-b'])`,
      [userId]
    );

    const photoStoragePath = (process.env.PHOTO_STORAGE_DIR || '/srv/vow/private-photos') + '/' + randomUUID() + '.jpg';
    await client.query(
      `INSERT INTO photo_assets (user_id, storage_path, mime_type, byte_size, width, height, review_status)
       VALUES ($1, $2, 'image/jpeg', 128, 1, 1, 'approved')`,
      [userId, photoStoragePath]
    );
    const l3Submission = await client.query(
      `INSERT INTO identity_l3_submissions (user_id, status, storage_object_key)
       VALUES ($1, 'draft', 'identity-l3/deleted-account-test') RETURNING id`,
      [userId]
    );

    const l3NoMediaSubmission = await client.query(
      `INSERT INTO identity_l3_submissions (user_id, status)
       VALUES ($1, 'draft') RETURNING id`,
      [userId]
    );

    await client.query(
      "INSERT INTO user_safety_screenings (user_id, scope, flags, severity, engine_version, review_status) VALUES ($1, 'profile', jsonb_build_array('profile_flag'), 'high', 'test-v1', 'pending')",
      [userId]
    );
    await client.query('SAVEPOINT active_gender_guard');
    await assert.rejects(
      client.query('UPDATE profiles SET gender = NULL WHERE user_id = $1', [userId]),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT active_gender_guard');

    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]);
    const screenings = await client.query(
      'SELECT COUNT(*)::int AS count FROM user_safety_screenings WHERE user_id = $1',
      [userId]
    );
    assert.equal(screenings.rows[0].count, 0,
      'account deletion must purge transient profile screening results');
    const photoAssets = await client.query(
      'SELECT COUNT(*)::int AS count FROM photo_assets WHERE user_id = $1',
      [userId]
    );
    assert.equal(photoAssets.rows[0].count, 0,
      'deleted-account transitions must remove photo metadata immediately');
    const photoPurge = await client.query(
      'SELECT COUNT(*)::int AS count FROM private_photo_purge_queue WHERE storage_path = $1',
      [photoStoragePath]
    );
    assert.equal(photoPurge.rows[0].count, 1,
      'deleted-account transitions must durably queue private photo bytes for unlink');
    const l3 = await client.query(
      'SELECT status, storage_object_key FROM identity_l3_submissions WHERE id = $1',
      [l3Submission.rows[0].id]
    );
    assert.equal(l3.rows[0]?.status, 'withdrawn',
      'a deleted account must retire any in-flight L3 submission');
    assert.equal(l3.rows[0]?.storage_object_key, 'identity-l3/deleted-account-test',
      'the encrypted object key must remain until the purge worker confirms deletion');
    const l3Purge = await client.query(
      'SELECT COUNT(*)::int AS count FROM identity_l3_media_purge_jobs WHERE submission_id = $1',
      [l3Submission.rows[0].id]
    );
    assert.equal(l3Purge.rows[0].count, 1,
      'deleted-account transitions must enqueue L3 media purge');

    const noMediaSubmission = await client.query(
      'SELECT id FROM identity_l3_submissions WHERE id = $1',
      [l3NoMediaSubmission.rows[0].id]
    );
    assert.equal(noMediaSubmission.rowCount, 0,
      'L3 workflow metadata without media must be deleted immediately for a tombstoned account');
    const noMediaEvents = await client.query(
      'SELECT id FROM identity_l3_decision_events WHERE submission_id = $1',
      [l3NoMediaSubmission.rows[0].id]
    );
    assert.equal(noMediaEvents.rowCount, 0,
      'decision events for a no-media L3 workflow must cascade with its deleted submission');

    // Simulate the purge worker's successful finalization: only after the
    // object key is cleared and the durable job is completed may tombstone
    // metadata and its cascaded decision events be removed.
    const purgeLeaseToken = randomUUID();
    await client.query(
      `UPDATE identity_l3_media_purge_jobs
       SET status = 'processing', attempts = 1, lease_token = $2,
           lease_expires_at = statement_timestamp() + INTERVAL '1 minute'
       WHERE submission_id = $1`,
      [l3Submission.rows[0].id, purgeLeaseToken]
    );
    await client.query(
      "SELECT set_config('app.identity_l3_actor_user_id', '', TRUE), set_config('app.identity_l3_reason_code', 'media_purged', TRUE)"
    );
    await client.query(
      `UPDATE identity_l3_submissions
       SET storage_object_key = NULL, media_purged_at = statement_timestamp()
       WHERE id = $1`,
      [l3Submission.rows[0].id]
    );
    await client.query(
      `UPDATE identity_l3_media_purge_jobs
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
           completed_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE submission_id = $1 AND lease_token = $2`,
      [l3Submission.rows[0].id, purgeLeaseToken]
    );
    assert.equal(
      await purgeDeletedAccountL3SubmissionMetadata(client, l3Submission.rows[0].id, userId),
      1,
      'the worker must remove L3 metadata after confirmed physical media purge for a deleted account'
    );
    const purgedSubmission = await client.query(
      'SELECT id FROM identity_l3_submissions WHERE id = $1',
      [l3Submission.rows[0].id]
    );
    assert.equal(purgedSubmission.rowCount, 0);
    const purgedJob = await client.query(
      'SELECT id FROM identity_l3_media_purge_jobs WHERE submission_id = $1',
      [l3Submission.rows[0].id]
    );
    assert.equal(purgedJob.rowCount, 0);
    const purgedEvents = await client.query(
      'SELECT id FROM identity_l3_decision_events WHERE submission_id = $1',
      [l3Submission.rows[0].id]
    );
    assert.equal(purgedEvents.rowCount, 0,
      'L3 decision history for a deleted account must be removed only after media purge is confirmed');

    const profile = await client.query(
      `SELECT display_name, birth_date, gender, country, city, bio, relationship_intent,
              is_visible, photo_urls, occupation, education, languages, family_format,
              has_children, children_disclosure_confirmed_at, wants_children,
              children_living_arrangement, family_values
       FROM profiles WHERE user_id = $1`,
      [userId]
    );
    assert.equal(profile.rowCount, 1);
    assert.deepEqual(profile.rows[0], {
      display_name: 'Удалённый пользователь',
      birth_date: null,
      gender: null,
      country: '—',
      city: '—',
      bio: '',
      relationship_intent: 'marriage_family',
      is_visible: false,
      photo_urls: [],
      occupation: '',
      education: '',
      languages: [],
      family_format: 'open_to_both',
      has_children: null,
      children_disclosure_confirmed_at: null,
      wants_children: 'discuss',
      children_living_arrangement: 'not_applicable',
      family_values: []
    });

    await client.query('SAVEPOINT deleted_account_terminal_guard');
    await assert.rejects(
      client.query("UPDATE users SET status = 'active' WHERE id = $1", [userId]),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT deleted_account_terminal_guard');
    await client.query('SAVEPOINT deleted_profile_immutable_guard');
    await assert.rejects(
      client.query("UPDATE profiles SET display_name = 'Reidentified Profile' WHERE user_id = $1", [userId]),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT deleted_profile_immutable_guard');

    await client.query('SAVEPOINT deleted_identity_immutable_guard');
    await assert.rejects(
      client.query("UPDATE users SET email = 'reidentified@example.invalid' WHERE id = $1", [userId]),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT deleted_identity_immutable_guard');

    const deletedAccount = await client.query(
      'SELECT email, password_hash, email_verified_at, phone_e164, phone_verified_at, female_trial_ends_at, premium_until, premium_lifetime FROM users WHERE id = $1',
      [userId]
    );
    assert.deepEqual(deletedAccount.rows[0], {
      email: 'deleted+' + userId + '@deleted.invalid',
      password_hash: null,
      email_verified_at: null,
      phone_e164: null,
      phone_verified_at: null,
      female_trial_ends_at: null,
      premium_until: null,
      premium_lifetime: false
    }, 'DB-level deletion must scrub credentials, contact details and trial entitlements');

    const deletedStatus = await client.query('SELECT status FROM users WHERE id = $1', [userId]);
    assert.equal(deletedStatus.rows[0]?.status, 'deleted',
      'a scrubbed deleted-account tombstone must not be reactivated');

    const nullable = await client.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'profiles' AND column_name = 'gender'`
    );
    assert.equal(nullable.rows[0]?.is_nullable, 'YES');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
