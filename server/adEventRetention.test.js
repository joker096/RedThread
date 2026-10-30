import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
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


test('PostgreSQL retention cleanup deletes only events strictly older than the retention boundary', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE ad_events (
        event_id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query(
      `INSERT INTO ad_events (event_id, created_at)
       VALUES
         ('00000000-0000-4000-8000-000000000001', NOW() - INTERVAL '90 days 1 second'),
         ('00000000-0000-4000-8000-000000000002', NOW() - INTERVAL '90 days'),
         ('00000000-0000-4000-8000-000000000003', NOW() - INTERVAL '89 days 23 hours 59 minutes 59 seconds')`
    );

    const deleted = await cleanupExpiredAdEvents(client, { retentionDays: 90, batchSize: 1 });
    assert.equal(deleted, 1, 'only the row older than 90 days is removed');

    const remaining = await client.query(
      'SELECT event_id::text FROM ad_events ORDER BY event_id'
    );
    assert.deepEqual(
      remaining.rows.map(row => row.event_id),
      [
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003'
      ],
      'the exact 90-day boundary and newer rows are retained'
    );
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
});

test('cleanup uses deterministic oldest-first ordering and checks for another batch after a full batch', async () => {
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      assert.match(sql, /ORDER BY created_at, event_id/);
      assert.match(sql, /LIMIT \$2/);
      assert.deepEqual(params, [90, 2]);
      calls.push(sql);
      return { rowCount: calls.length <= 2 ? 2 : 0 };
    }
  };

  const deleted = await cleanupExpiredAdEvents(fakePool, { retentionDays: 90, batchSize: 2 });
  assert.equal(deleted, 4);
  assert.equal(calls.length, 3, 'a full final batch is followed by an empty query to prove cleanup is complete');
});
