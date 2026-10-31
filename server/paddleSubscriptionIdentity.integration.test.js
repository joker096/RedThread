import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('Paddle subscription IDs have a unique partial database index', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'users'
         AND indexname = 'users_paddle_subscription_id_unique'`
    );
    assert.equal(result.rowCount, 1, 'migration 103 should install the subscription identity index');
    assert.match(result.rows[0].indexdef, /CREATE UNIQUE INDEX/i);
    assert.match(result.rows[0].indexdef, /\(paddle_subscription_id\)/i);
    assert.match(result.rows[0].indexdef, /WHERE \(paddle_subscription_id IS NOT NULL\)/i);
  } finally {
    await pool.end();
  }
});
