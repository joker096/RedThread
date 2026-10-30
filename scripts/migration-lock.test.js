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

    let secondAcquired = false;
    secondAcquire.then(result => {
      secondAcquired = Boolean(result.release);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(secondAcquired, false, 'the second migrator must wait while the first holds the session lock');

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
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [{ unlocked: true }] };
    }
  };
  const release = await acquireMigrationLock(client);
  await release();
  await release();
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /pg_try_advisory_lock/);
  assert.match(calls[1].sql, /pg_advisory_unlock/);
  assert.deepEqual(calls[0].params, [MIGRATION_ADVISORY_LOCK_CLASS, MIGRATION_ADVISORY_LOCK_ID]);
});

test('migration lock acquisition can be cancelled before acquiring a lock', async () => {
  let calls = 0;
  const client = {
    async query() {
      calls += 1;
      return { rows: [{ acquired: false }] };
    }
  };

  const release = await acquireMigrationLock(client, {
    shouldAbort: () => true
  });

  assert.equal(release, null);
  assert.equal(calls, 0);
});
