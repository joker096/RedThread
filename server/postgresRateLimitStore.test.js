import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRateLimitStore } from './postgresRateLimitStore.js';

test('PostgreSQL rate-limit store prefixes keys and returns reset time', async () => {
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('RETURNING hits, window_started_at')) {
        return { rows: [{ hits: 3, window_started_at: new Date('2026-01-01T00:00:00.000Z') }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const store = new PostgresRateLimitStore(fakePool, 'test');
  store.init({ windowMs: 60_000 });
  const result = await store.increment('127.0.0.1');
  assert.equal(result.totalHits, 3);
  assert.equal(result.resetTime.toISOString(), '2026-01-01T00:01:00.000Z');
  assert.deepEqual(calls[0].params, ['test:127.0.0.1', 60_000]);
  await store.decrement('127.0.0.1');
  await store.resetKey('127.0.0.1');
  assert.equal(calls.length, 3);
});
