import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IDENTITY_L3_EXPIRY_BATCH_SIZE,
  normalizeIdentityL3ExpiryBatchSize,
  processExpiredIdentityL3ApprovalBatch
} from './expire-identity-l3-approvals.js';

function fakePool({ candidates = [], expiredRows = [], failForUser = null } = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ scope: 'pool', sql: String(sql), params });
      return { rows: candidates, rowCount: candidates.length };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ scope: 'client', sql: String(sql), params });
          if (String(sql).includes('UPDATE identity_l3_submissions')) {
            if (params[0] === failForUser) throw Object.assign(new Error('db failure'), { code: 'XX000' });
            return { rows: expiredRows, rowCount: expiredRows.length };
          }
          return { rows: [], rowCount: 0 };
        },
        release(error) { calls.push({ scope: 'release', error: error?.code || null }); }
      };
    }
  };
  return pool;
}

test('L3 expiry batch size is bounded', () => {
  assert.equal(DEFAULT_IDENTITY_L3_EXPIRY_BATCH_SIZE, 100);
  assert.equal(normalizeIdentityL3ExpiryBatchSize('25'), 25);
  for (const value of [0, -1, 1001, 1.5, 'nope', null]) {
    assert.throws(() => normalizeIdentityL3ExpiryBatchSize(value), RangeError);
  }
});

test('L3 expiry worker uses bounded candidate discovery and expires under account safety lock', async () => {
  const pool = fakePool({
    candidates: [{ user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    expiredRows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]
  });
  const locks = [];
  const summary = await processExpiredIdentityL3ApprovalBatch(pool, {
    batchSize: 10,
    acquireSafetyLocks: async (client, userId) => { locks.push(userId); }
  });
  assert.deepEqual(summary, { accountsScanned: 1, approvalsExpired: 1, accountFailures: 0 });
  assert.deepEqual(locks, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  const candidateQuery = pool.calls.find(call => call.scope === 'pool');
  assert.match(candidateQuery.sql, /status = 'approved' AND expires_at <= NOW\(\)/);
  assert.equal(candidateQuery.params[0], 10);
  const config = pool.calls.find(call => call.sql.includes('set_config'));
  assert.ok(config.sql.includes('approval_expired'));
  const update = pool.calls.find(call => call.sql.includes('UPDATE identity_l3_submissions'));
  assert.match(update.sql, /status = 'expired'/);
  assert.match(update.sql, /expires_at <= NOW\(\)/);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.at(-1).scope, 'release');
});

test('L3 expiry worker isolates account failures and continues the bounded batch', async () => {
  const pool = fakePool({
    candidates: [
      { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    ],
    expiredRows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    failForUser: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const summary = await processExpiredIdentityL3ApprovalBatch(pool, {
      acquireSafetyLocks: async () => {}
    });
    assert.deepEqual(summary, { accountsScanned: 2, approvalsExpired: 1, accountFailures: 1 });
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
  } finally {
    console.error = originalError;
  }
});

test('L3 expiry worker never processes candidates when discovery returns none', async () => {
  const pool = fakePool();
  const summary = await processExpiredIdentityL3ApprovalBatch(pool);
  assert.deepEqual(summary, { accountsScanned: 0, approvalsExpired: 0, accountFailures: 0 });
  assert.equal(pool.calls.filter(call => call.scope === 'client').length, 0);
});
