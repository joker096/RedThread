import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  acquireMigrationLock,
  MIGRATION_ADVISORY_LOCK_CLASS,
  MIGRATION_ADVISORY_LOCK_ID
} from './migration-lock.js';

const { Pool } = pg;

test('migration advisory lock is session-scoped and serializes concurrent migrators', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const first = await pool.connect();
  const second = await pool.connect();
  let releaseFirst;
  let releaseSecond;
  let secondAcquire;
  try {
    releaseFirst = await acquireMigrationLock(first);
    secondAcquire = acquireMigrationLock(second).then(
      release => ({ release }),
      error => ({ error })
    );

    const lockQuery = '%pg_advisory_lock($1, $2)%';
    const deadline = Date.now() + 5_000;
    let waiting = false;
    while (Date.now() < deadline && !waiting) {
      const result = await first.query(
        `SELECT 1
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE $1
         LIMIT 1`,
        [lockQuery]
      );
      waiting = result.rowCount > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true, 'the second migrator must wait while the first holds the session lock');

    await releaseFirst();
    releaseFirst = null;
    const acquired = await secondAcquire;
    assert.equal(acquired.error, undefined);
    releaseSecond = acquired.release;

    await second.query('BEGIN');
    await second.query('COMMIT');
    await releaseSecond();
    releaseSecond = null;
  } finally {
    if (releaseFirst) await releaseFirst().catch(() => {});
    if (releaseSecond) await releaseSecond().catch(() => {});
    if (secondAcquire) {
      const acquired = await secondAcquire;
      if (acquired.release) await acquired.release().catch(() => {});
    }
    first.release();
    second.release();
    await pool.end();
  }
});

test('migration lock release is idempotent', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ unlocked: true }] };
    }
  };
  const release = await acquireMigrationLock(client);
  await release();
  await release();
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /pg_advisory_lock/);
  assert.match(calls[1].sql, /pg_advisory_unlock/);
  assert.deepEqual(calls[0].params, [MIGRATION_ADVISORY_LOCK_CLASS, MIGRATION_ADVISORY_LOCK_ID]);
});
