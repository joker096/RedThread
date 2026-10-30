import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GIFT_EXPIRY_BATCH_SIZE,
  normalizeGiftExpiryBatchSize,
  processExpiredGiftRequestBatch
} from './expire-gift-requests.js';

const pair = {
  matchId: 'match-1',
  senderId: 'sender-1',
  recipientId: 'recipient-1'
};

function mockPool(rows = [pair]) {
  const calls = [];
  const client = {
    async query(sql) { calls.push(sql); return { rows: [] }; },
    release() { calls.push('RELEASE'); }
  };
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows };
    },
    async connect() { calls.push('CONNECT'); return client; }
  };
}

test('gift expiry batch size is bounded and defaults safely', () => {
  assert.equal(DEFAULT_GIFT_EXPIRY_BATCH_SIZE, 100);
  assert.equal(normalizeGiftExpiryBatchSize(), 100);
  assert.equal(normalizeGiftExpiryBatchSize('25'), 25);
  for (const value of [0, -1, 1001, 1.5, 'nope', null]) {
    assert.throws(() => normalizeGiftExpiryBatchSize(value), RangeError);
  }
});

test('expiry worker takes creation locks in the established order and commits safe expirations', async () => {
  const pool = mockPool();
  const order = [];
  const result = await processExpiredGiftRequestBatch(pool, {
    batchSize: 10,
    acquireRateLocks: async () => order.push('rate'),
    acquireSafetyLocks: async () => order.push('safety-users'),
    acquirePairLock: async () => order.push('pair'),
    expirePair: async (_client, candidate) => {
      assert.deepEqual(candidate, pair);
      order.push('expire');
      return { ok: true, expiredOrders: [{ id: 'order-1' }, { id: 'order-2' }] };
    }
  });
  const discovery = pool.calls.find(call => typeof call === 'object');
  assert.match(discovery.sql, /NOT EXISTS/);
  assert.match(discovery.sql, /expired_active_payment/);
  assert.match(discovery.sql, /payment_status IN \\('not_started', 'voided', 'failed'\\)/);
  assert.deepEqual(order, ['rate', 'safety-users', 'pair', 'expire']);
  assert.deepEqual(result, { pairsScanned: 1, expiredOrders: 2, reconciliationRequired: 0 });
  assert.ok(pool.calls.includes('COMMIT'));
  assert.ok(pool.calls.includes('RELEASE'));
});

test('expiry worker commits reconciliation outbox work without expiring uncertain payments', async () => {
  const pool = mockPool();
  const result = await processExpiredGiftRequestBatch(pool, {
    acquireRateLocks: async () => {},
    acquireSafetyLocks: async () => {},
    acquirePairLock: async () => {},
    expirePair: async () => ({
      ok: false,
      commit: true,
      error: 'gift_payment_requires_reconciliation',
      expiredOrders: [{ id: 'inactive-order' }]
    })
  });
  assert.deepEqual(result, { pairsScanned: 1, expiredOrders: 1, reconciliationRequired: 1 });
  assert.ok(pool.calls.includes('COMMIT'));
  assert.ok(!pool.calls.includes('ROLLBACK'));
});

test('expiry worker rolls back denied work and releases its connection', async () => {
  const pool = mockPool();
  const result = await processExpiredGiftRequestBatch(pool, {
    acquireRateLocks: async () => {},
    acquireSafetyLocks: async () => {},
    acquirePairLock: async () => {},
    expirePair: async () => ({ ok: false, commit: false, expiredOrders: [] })
  });
  assert.deepEqual(result, { pairsScanned: 1, expiredOrders: 0, reconciliationRequired: 0 });
  assert.ok(pool.calls.includes('ROLLBACK'));
  assert.ok(pool.calls.includes('RELEASE'));
});

test('expiry worker rolls back and releases when a pair fails', async () => {
  const pool = mockPool();
  await assert.rejects(processExpiredGiftRequestBatch(pool, {
    acquireRateLocks: async () => {},
    acquireSafetyLocks: async () => {},
    acquirePairLock: async () => {},
    expirePair: async () => { throw new Error('database unavailable'); }
  }), /database unavailable/);
  assert.ok(pool.calls.includes('ROLLBACK'));
  assert.ok(pool.calls.includes('RELEASE'));
});

test('expiry worker does not open transactions when no expired pairs exist', async () => {
  const pool = mockPool([]);
  const result = await processExpiredGiftRequestBatch(pool);
  assert.deepEqual(result, { pairsScanned: 0, expiredOrders: 0, reconciliationRequired: 0 });
  assert.equal(pool.calls.filter(call => call === 'CONNECT').length, 0);
});
