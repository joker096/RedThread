import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  DEFAULT_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE,
  cleanupExpiredFemaleProfileExposures,
  normalizeFemaleProfileExposureCleanupBatchSize
} from './cleanup-female-profile-exposures.js';

test('female profile exposure cleanup uses a bounded batch size', () => {
  assert.equal(DEFAULT_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE, 1000);
  assert.equal(normalizeFemaleProfileExposureCleanupBatchSize(), 1000);
  assert.equal(normalizeFemaleProfileExposureCleanupBatchSize(1), 1);
  assert.equal(normalizeFemaleProfileExposureCleanupBatchSize(5000), 5000);
  assert.throws(() => normalizeFemaleProfileExposureCleanupBatchSize(0), /batch size/);
  assert.throws(() => normalizeFemaleProfileExposureCleanupBatchSize(5001), /batch size/);
  assert.throws(() => normalizeFemaleProfileExposureCleanupBatchSize(1.5), /batch size/);
  assert.throws(() => normalizeFemaleProfileExposureCleanupBatchSize(Number.NaN), /batch size/);
});

test('cleanup deletes prior UTC days in bounded batches until the last partial batch', async () => {
  const deletedPerBatch = [2, 2, 1];
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /\(clock_timestamp\(\) AT TIME ZONE 'UTC'\)::date/);
      assert.match(sql, /exposure_date < utc_day\.current_utc_date/);
      assert.match(sql, /ORDER BY exposure\.exposure_date, exposure\.user_id, exposure\.profile_user_id/);
      assert.match(sql, /LIMIT \$1/);
      assert.match(sql, /FOR UPDATE OF exposure SKIP LOCKED/);
      assert.match(sql, /DELETE FROM female_profile_exposures AS exposures/);
      assert.deepEqual(params, [2]);
      return { rowCount: deletedPerBatch[calls.length - 1] ?? 0 };
    }
  };

  const deleted = await cleanupExpiredFemaleProfileExposures(fakePool, { batchSize: 2 });
  assert.equal(deleted, 5);
  assert.equal(calls.length, 3);
});

test('PostgreSQL cleanup removes only rows from prior UTC calendar days', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE female_profile_exposures (
        user_id uuid NOT NULL,
        profile_user_id uuid NOT NULL,
        exposure_date date NOT NULL,
        PRIMARY KEY (user_id, exposure_date, profile_user_id)
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query(`
      WITH utc_day AS MATERIALIZED (
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS current_utc_date
      )
      INSERT INTO female_profile_exposures (user_id, profile_user_id, exposure_date)
      SELECT
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000002'::uuid,
        current_utc_date - 1
      FROM utc_day
      UNION ALL
      SELECT
        '00000000-0000-4000-8000-000000000003'::uuid,
        '00000000-0000-4000-8000-000000000004'::uuid,
        current_utc_date
      FROM utc_day
    `);

    const deleted = await cleanupExpiredFemaleProfileExposures(client, { batchSize: 1 });
    assert.equal(deleted, 1, 'only the previous UTC day row is removed');

    const remaining = await client.query(
      'SELECT count(*)::int AS count FROM female_profile_exposures'
    );
    assert.equal(remaining.rows[0].count, 1, 'the current UTC day row is retained');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
});

test('cleanup propagates a failed batch without reporting partial success', async () => {
  const failure = new Error('database unavailable');
  let calls = 0;
  const fakePool = {
    async query() {
      calls += 1;
      throw failure;
    }
  };

  await assert.rejects(
    cleanupExpiredFemaleProfileExposures(fakePool, { batchSize: 10 }),
    error => error === failure
  );
  assert.equal(calls, 1);
});
