import test from 'node:test';
import assert from 'node:assert/strict';
import { withPooledTransaction } from './withPooledTransaction.js';

function createPool({ beginError, commitError, rollbackError } = {}) {
  const calls = [];
  let released = false;
  let releaseError;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' && beginError) throw beginError;
      if (sql === 'COMMIT' && commitError) throw commitError;
      if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
      return { rows: [] };
    },
    release(error) {
      released = true;
      releaseError = error;
    }
  };
  return {
    pool: { async connect() { return client; } },
    calls,
    get released() { return released; },
    get releaseError() { return releaseError; }
  };
}

test('pooled transaction commits successful work and releases a healthy client', async () => {
  const fixture = createPool();
  const value = await withPooledTransaction(fixture.pool, async client => {
    await client.query('SELECT 1');
    return 'result';
  });

  assert.equal(value, 'result');
  assert.deepEqual(fixture.calls, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.equal(fixture.released, true);
  assert.equal(fixture.releaseError, undefined);
});

test('pooled transaction rolls back callback failures before reusing the client', async () => {
  const fixture = createPool();
  const failure = new Error('callback failed');

  await assert.rejects(
    withPooledTransaction(fixture.pool, async () => { throw failure; }),
    error => error === failure
  );

  assert.deepEqual(fixture.calls, ['BEGIN', 'ROLLBACK']);
  assert.equal(fixture.released, true);
  assert.equal(fixture.releaseError, undefined);
});

test('pooled transaction destroys a client when rollback fails', async () => {
  const fixture = createPool({ rollbackError: new Error('rollback connection lost') });
  const failure = new Error('query failed');

  await assert.rejects(
    withPooledTransaction(fixture.pool, async () => { throw failure; }),
    error => error === failure
  );

  assert.deepEqual(fixture.calls, ['BEGIN', 'ROLLBACK']);
  assert.equal(fixture.released, true);
  assert.equal(fixture.releaseError.message, 'rollback connection lost');
});

test('pooled transaction destroys a client when BEGIN fails', async () => {
  const failure = new Error('begin connection lost');
  const fixture = createPool({ beginError: failure });

  await assert.rejects(
    withPooledTransaction(fixture.pool, async () => 'unreachable'),
    error => error === failure
  );

  assert.deepEqual(fixture.calls, ['BEGIN']);
  assert.equal(fixture.released, true);
  assert.equal(fixture.releaseError, failure);
});

test('pooled transaction rolls back a failed COMMIT and preserves its original error', async () => {
  const failure = new Error('commit failed');
  const fixture = createPool({ commitError: failure });

  await assert.rejects(
    withPooledTransaction(fixture.pool, async () => 'result'),
    error => error === failure
  );

  assert.deepEqual(fixture.calls, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(fixture.released, true);
  assert.equal(fixture.releaseError, undefined);
});
