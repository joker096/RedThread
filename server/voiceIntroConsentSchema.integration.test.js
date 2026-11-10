import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('voice intro consent state requires same-transaction immutable audit events', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const userId = randomUUID();
  const email = `voice-consent-${userId}@example.invalid`;
  let client;
  try {
    client = await pool.connect();
    const tables = await client.query(
      `SELECT to_regclass('public.profile_voice_intro_consents') AS current_consent,
              to_regclass('public.profile_voice_intro_consent_events') AS consent_events`
    );
    assert.equal(tables.rows[0].current_consent, 'profile_voice_intro_consents');
    assert.equal(tables.rows[0].consent_events, 'profile_voice_intro_consent_events');
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profile_voice_intro_consent_events'`
    );
    const names = new Set(columns.rows.map(row => row.column_name));
    for (const name of ['actor_user_id', 'event_type', 'consent_version', 'occurred_at', 'recorded_txid']) {
      assert.ok(names.has(name), `missing consent audit column: ${name}`);
    }

    await client.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [userId, email]
    );

    await client.query('BEGIN');
    await client.query(
      'INSERT INTO profile_voice_intro_consents (user_id, consent_version) VALUES ($1, 1)',
      [userId]
    );
    await assert.rejects(client.query('COMMIT'), error => error.code === '23514');
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    const grant = await client.query(
      `INSERT INTO profile_voice_intro_consents (user_id, consent_version)
       VALUES ($1, 1) RETURNING granted_at`,
      [userId]
    );
    await client.query(
      `INSERT INTO profile_voice_intro_consent_events
         (user_id, actor_user_id, event_type, consent_version, occurred_at)
       VALUES ($1, $1, 'granted', 1, $2)`,
      [userId, grant.rows[0].granted_at]
    );
    await client.query('COMMIT');

    await client.query('BEGIN');
    await assert.rejects(
      client.query(
        `INSERT INTO profile_voice_intro_consent_events
           (user_id, actor_user_id, event_type, consent_version, occurred_at)
         SELECT user_id, user_id, 'granted', consent_version, granted_at
         FROM profile_voice_intro_consents WHERE user_id = $1`,
        [userId]
      ),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await assert.rejects(
      client.query('DELETE FROM profile_voice_intro_consent_events WHERE user_id = $1', [userId]),
      error => error.code === '55000'
    );
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    const withdrawn = await client.query(
      `UPDATE profile_voice_intro_consents
       SET withdrawn_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE user_id = $1 RETURNING consent_version, withdrawn_at`,
      [userId]
    );
    await client.query(
      `INSERT INTO profile_voice_intro_consent_events
         (user_id, actor_user_id, event_type, consent_version, occurred_at)
       VALUES ($1, $1, 'withdrawn', $2, $3)`,
      [userId, withdrawn.rows[0].consent_version, withdrawn.rows[0].withdrawn_at]
    );
    await client.query('COMMIT');

    const state = await client.query(
      'SELECT withdrawn_at IS NOT NULL AS withdrawn FROM profile_voice_intro_consents WHERE user_id = $1',
      [userId]
    );
    assert.equal(state.rows[0].withdrawn, true);

    await client.query('BEGIN');
    await client.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]);
    await client.query('DELETE FROM profile_voice_intro_consent_events WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM profile_voice_intro_consents WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    const remaining = await client.query(
      'SELECT (SELECT count(*) FROM profile_voice_intro_consent_events WHERE user_id = $1) AS events, (SELECT count(*) FROM profile_voice_intro_consents WHERE user_id = $1) AS states',
      [userId]
    );
    assert.equal(Number(remaining.rows[0].events), 0);
    assert.equal(Number(remaining.rows[0].states), 0);
  } finally {
    if (client) {
      try {
        await client.query('UPDATE users SET status = \'deleted\' WHERE id = $1', [userId]);
        await client.query('DELETE FROM profile_voice_intro_consent_events WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM profile_voice_intro_consents WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
      } catch {}
      client.release();
    }
    await pool.end();
  }
});
