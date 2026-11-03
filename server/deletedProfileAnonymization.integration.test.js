import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('account deletion scrubs profile personal data in the database', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const email = `deleted-profile-${randomUUID()}@example.invalid`;
  let userId;
  try {
    await client.query('BEGIN');
    const user = await client.query(
      "INSERT INTO users (email, password_hash, status) VALUES ($1, 'test-only-hash', 'active') RETURNING id",
      [email]
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

    await client.query(
      "INSERT INTO user_safety_screenings (user_id, scope, flags, severity, engine_version, review_status) VALUES ($1, 'profile', jsonb_build_array('profile_flag'), 'high', 'test-v1', 'pending')",
      [userId]
    );
    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]);
    const screenings = await client.query(
      'SELECT COUNT(*)::int AS count FROM user_safety_screenings WHERE user_id = $1',
      [userId]
    );
    assert.equal(screenings.rows[0].count, 0,
      'account deletion must purge transient profile screening results');
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
