import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('female free discovery quota migration persists unique daily views and match events', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 8_000
  });
  const client = await pool.connect();
  const firstUser = randomUUID();
  const secondUser = randomUUID();
  const [userA, userB] = [firstUser, secondUser].sort();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, status) VALUES
       ($1, $3, 'active'), ($2, $4, 'active')`,
      [userA, userB, `quota-${firstUser}@example.test`, `quota-${secondUser}@example.test`]
    );

    const view = await client.query(
      `INSERT INTO profile_discovery_views (user_id, profile_id, viewed_on)
       VALUES ($1, $2, (statement_timestamp() AT TIME ZONE 'UTC')::date)
       ON CONFLICT (user_id, profile_id, viewed_on) DO NOTHING
       RETURNING profile_id`,
      [userA, userB]
    );
    const duplicateView = await client.query(
      `INSERT INTO profile_discovery_views (user_id, profile_id, viewed_on)
       VALUES ($1, $2, (statement_timestamp() AT TIME ZONE 'UTC')::date)
       ON CONFLICT (user_id, profile_id, viewed_on) DO NOTHING
       RETURNING profile_id`,
      [userA, userB]
    );
    assert.equal(view.rowCount, 1);
    assert.equal(duplicateView.rowCount, 0);

    const match = await client.query(
      'INSERT INTO matches (user_a_id, user_b_id) VALUES ($1, $2) RETURNING id',
      [userA, userB]
    );
    const event = await client.query(
      'INSERT INTO female_free_match_quota_events (user_id, match_id) VALUES ($1, $2) RETURNING match_id',
      [userA, match.rows[0].id]
    );
    const duplicateEvent = await client.query(
      'INSERT INTO female_free_match_quota_events (user_id, match_id) VALUES ($1, $2) ON CONFLICT (match_id) DO NOTHING RETURNING match_id',
      [userA, match.rows[0].id]
    );
    assert.equal(event.rowCount, 1);
    assert.equal(duplicateEvent.rowCount, 0);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
