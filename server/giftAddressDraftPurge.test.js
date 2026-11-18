import test from 'node:test';
import assert from 'node:assert/strict';
import { purgeExpiredGiftAddressDrafts, normalizeGiftAddressDraftPurgeBatchSize } from './giftAddressDraftPurge.js';

test('purge batch size is bounded', () => {
  assert.equal(normalizeGiftAddressDraftPurgeBatchSize(25), 25);
  for (const value of [0, -1, 1001, 1.5, 'bad']) assert.throws(() => normalizeGiftAddressDraftPurgeBatchSize(value));
});

test('purge atomically deletes expired ciphertext and records consent expiry', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT COUNT(*)::int AS purged')) return { rows: [{ purged: 3 }] };
      return { rows: [] };
    },
    release() { calls.push({ release: true }); }
  };
  const pool = { async connect() { return client; } };
  assert.deepEqual(await purgeExpiredGiftAddressDrafts(pool, { batchSize: 10 }), { purged: 3 });
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /DELETE FROM gift_address_drafts/);
  assert.match(calls[1].sql, /INSERT INTO gift_address_draft_consent_events/);
  assert.match(calls[1].sql, /SELECT consent_version/);
  assert.match(calls[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(calls[2].sql, 'COMMIT');
  assert.ok(calls.some(call => call.release));
});

test('purge rolls back on failure', async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); if (sql.includes('WITH due')) throw new Error('db unavailable'); return {}; }, release() {} };
  await assert.rejects(() => purgeExpiredGiftAddressDrafts({ connect: async () => client }), /db unavailable/);
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /^WITH due AS/);
  assert.equal(calls[2], 'ROLLBACK');
});


test('purge destroys a connection when PostgreSQL rollback fails', async () => {
  const calls = [];
  let releasedWith = null;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('WITH due')) throw new Error('purge_statement_failed');
      if (sql === 'ROLLBACK') throw new Error('rollback_connection_lost');
      return {};
    },
    release(error) { releasedWith = error || null; }
  };
  const pool = { async connect() { return client; } };
  await assert.rejects(() => purgeExpiredGiftAddressDrafts(pool), /purge_statement_failed/);
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /^WITH due AS/);
  assert.equal(calls[2], 'ROLLBACK');
  assert.equal(releasedWith?.message, 'rollback_connection_lost',
    'a connection with uncertain transaction state must be destroyed');
});
