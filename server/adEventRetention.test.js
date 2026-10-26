import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_EVENT_RETENTION_DAYS,
  DEFAULT_AD_EVENT_CLEANUP_BATCH_SIZE,
  cleanupExpiredAdEvents,
  normalizeCleanupOptions
} from '../scripts/cleanup-ad-events.js';

test('ad event retention defaults to 90 days and bounded batches', () => {
  assert.equal(AD_EVENT_RETENTION_DAYS, 90);
  assert.deepEqual(normalizeCleanupOptions(), {
    retentionDays: 90,
    batchSize: DEFAULT_AD_EVENT_CLEANUP_BATCH_SIZE
  });
  assert.throws(() => normalizeCleanupOptions({ retentionDays: 0 }), /retentionDays/);
  assert.throws(() => normalizeCleanupOptions({ batchSize: 5001 }), /batchSize/);
});

test('cleanup deletes in bounded batches until the last partial batch', async () => {
  const batchSizes = [];
  let call = 0;
  const fakePool = {
    async query(sql, params) {
      assert.match(sql, /created_at < NOW\(\) - make_interval/);
      assert.match(sql, /LIMIT \$2/);
      assert.deepEqual(params, [90, 2]);
      call += 1;
      const rowCount = call === 1 ? 2 : call === 2 ? 1 : 0;
      batchSizes.push(rowCount);
      return { rowCount };
    }
  };

  const deleted = await cleanupExpiredAdEvents(fakePool, { retentionDays: 90, batchSize: 2 });
  assert.equal(deleted, 3);
  assert.deepEqual(batchSizes, [2, 1]);
});
