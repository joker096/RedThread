import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  DEFAULT_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE,
  cleanupExpiredAccountReuseRestrictions,
  normalizeAccountReuseCleanupBatchSize
} from './cleanup-account-reuse-restrictions.js';

test('account reuse cleanup validates bounded batches', () => {
  assert.equal(DEFAULT_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE, 500);
  assert.equal(normalizeAccountReuseCleanupBatchSize(), 500);
  assert.equal(normalizeAccountReuseCleanupBatchSize(1), 1);
  assert.equal(normalizeAccountReuseCleanupBatchSize(5000), 5000);
  for (const value of [0, -1, 5001, 1.5, Number.NaN]) {
    assert.throws(() => normalizeAccountReuseCleanupBatchSize(value), /batch size/);
  }
});

test('account reuse cleanup deletes expired HMAC rows in bounded batches', async () => {
  const counts = [2, 1];
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /expires_at <= clock_timestamp\(\)/);
      assert.match(sql, /ORDER BY expires_at, email_hmac/);
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      assert.match(sql, /DELETE FROM account_reuse_restrictions/);
      assert.deepEqual(params, [2]);
      return { rowCount: counts[calls.length - 1] ?? 0 };
    }
  };
  assert.equal(await cleanupExpiredAccountReuseRestrictions(pool, { batchSize: 2 }), 3);
  assert.equal(calls.length, 2);
});

test('account reuse cleanup propagates database failures', async () => {
  const failure = new Error('database unavailable');
  const pool = { async query() { throw failure; } };
  await assert.rejects(cleanupExpiredAccountReuseRestrictions(pool, { batchSize: 10 }), error => error === failure);
});


test('PostgreSQL cleanup removes expired restrictions and preserves active ones', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE account_reuse_restrictions (
        email_hmac char(64) PRIMARY KEY,
        expires_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query(
      `INSERT INTO account_reuse_restrictions (email_hmac, expires_at)
       VALUES ($1, clock_timestamp() - INTERVAL '1 second'),
              ($2, clock_timestamp() + INTERVAL '1 day')`,
      ['a'.repeat(64), 'b'.repeat(64)]
    );
    const deleted = await cleanupExpiredAccountReuseRestrictions(client, { batchSize: 1 });
    assert.equal(deleted, 1, 'only the expired HMAC restriction is removed');
    const remaining = await client.query(
      'SELECT email_hmac FROM account_reuse_restrictions'
    );
    assert.deepEqual(remaining.rows, [{ email_hmac: 'b'.repeat(64) }],
      'an active 90-day restriction remains in place');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
});
