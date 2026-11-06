import test from 'node:test';
import assert from 'node:assert/strict';
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
