import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionMutationQueue } from './sessionMutationQueue.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('an in-flight refresh cannot publish credentials after logout invalidates its generation', async () => {
  const queue = createSessionMutationQueue();
  const generation = queue.currentGeneration();
  const writeStarted = deferred<void>();
  const finishWrite = deferred<void>();
  const stored: string[] = [];

  const staleRefresh = queue.run(generation, async isCurrent => {
    writeStarted.resolve();
    await finishWrite.promise;
    if (!isCurrent()) {
      stored.push('stale-write-cleanup');
      return false;
    }
    stored.push('old-refresh-token');
    return true;
  });

  await writeStarted.promise;
  const logoutGeneration = queue.invalidate();
  const logout = queue.run(logoutGeneration, async () => {
    stored.push('secure-remove');
    return true;
  });
  finishWrite.resolve();

  assert.equal(await staleRefresh, false);
  assert.equal(await logout, true);
  assert.deepEqual(stored, ['stale-write-cleanup', 'secure-remove']);
});

test('queued refresh work is skipped after a session switch', async () => {
  const queue = createSessionMutationQueue();
  const oldGeneration = queue.currentGeneration();
  const blocker = deferred<void>();
  const first = queue.run(oldGeneration, async () => { await blocker.promise; return true; });
  const stale = queue.run(oldGeneration, async () => {
    assert.fail('stale operation must not touch secure storage');
  });
  const nextGeneration = queue.invalidate();
  const newSession = queue.run(nextGeneration, async () => 'new-refresh-token');

  blocker.resolve();
  assert.equal(await first, false);
  assert.equal(await stale, false);
  assert.equal(await newSession, 'new-refresh-token');
});

test('a delayed invalid refresh response cannot clear a newer login', async () => {
  const queue = createSessionMutationQueue();
  const oldGeneration = queue.currentGeneration();
  const newGeneration = queue.invalidate();
  assert.equal(queue.isCurrent(oldGeneration), false);
  assert.equal(queue.isCurrent(newGeneration), true);

  const staleClear = queue.run(oldGeneration, async () => {
    assert.fail('old refresh response must not clear the new session');
  });
  const newLogin = queue.run(newGeneration, async () => 'new-session');
  assert.equal(await staleClear, false);
  assert.equal(await newLogin, 'new-session');
});
