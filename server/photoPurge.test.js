import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import { privatePhotoPurgeExitCode } from './process-private-photo-purge.js';
import {
  normalizePrivatePhotoPurgeBatchSize,
  resolvePrivatePhotoPath,
  privatePhotoPurgeRetryDelayMs,
  queuePrivatePhotoPurges
} from './photoPurge.js';

const root = path.resolve('/srv/vow/private-photos');
const validPath = path.join(root, '123e4567-e89b-42d3-a456-426614174000.jpg');

test('private photo purge batch size is bounded', () => {
  assert.equal(normalizePrivatePhotoPurgeBatchSize('25'), 25);
  for (const value of [0, -1, 1001, 'nope', 1.5]) {
    assert.throws(() => normalizePrivatePhotoPurgeBatchSize(value), RangeError);
  }
});

test('private photo path accepts only generated files directly under storage root', () => {
  assert.equal(resolvePrivatePhotoPath(validPath, root), validPath);
  for (const value of [
    '/etc/passwd',
    path.join(root, '..', 'secret.jpg'),
    path.join(root, 'nested', '123e4567-e89b-42d3-a456-426614174000.jpg'),
    path.join(root, 'not-a-uuid.jpg'),
    path.join(root, '123e4567-e89b-42d3-a456-426614174000.gif')
  ]) {
    assert.throws(() => resolvePrivatePhotoPath(value, root), error => error.code === 'PHOTO_PATH_INVALID');
  }
  assert.throws(() => resolvePrivatePhotoPath(validPath, ''), TypeError);
});

test('private photo purge retries use capped exponential backoff', () => {
  assert.equal(privatePhotoPurgeRetryDelayMs(0), 60_000);
  assert.equal(privatePhotoPurgeRetryDelayMs(1), 120_000);
  assert.equal(privatePhotoPurgeRetryDelayMs(9), 6 * 60 * 60 * 1000);
  assert.equal(privatePhotoPurgeRetryDelayMs(20), 6 * 60 * 60 * 1000);
  assert.throws(() => privatePhotoPurgeRetryDelayMs(-1), RangeError);
});

test('queueing deduplicates paths and safely handles an empty list', async () => {
  const calls = [];
  const client = { query: async (...args) => { calls.push(args); return { rowCount: 2 }; } };
  assert.equal(await queuePrivatePhotoPurges(client, []), 0);
  assert.equal(calls.length, 0);
  assert.equal(await queuePrivatePhotoPurges(client, [validPath, validPath, null]), 2);
  assert.deepEqual(calls[0][1], [[validPath]]);
});

test('purge worker deletes a file and its queue row transactionally', async () => {
  const statements = [];
  const task = { id: 'task-1', storage_path: validPath, attempts: 0 };
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT id, storage_path, attempts')) return { rows: [task], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  const pool = {
    query: async () => ({ rows: [{ id: task.id }] }),
    connect: async () => client
  };
  const removed = [];
  const { processPrivatePhotoPurgeBatch } = await import('./photoPurge.js');
  const summary = await processPrivatePhotoPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async file => removed.push(file)
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 1, retried: 0, failures: 0 });
  assert.deepEqual(removed, [validPath]);
  assert.ok(statements.some(item => item.sql.startsWith('DELETE FROM private_photo_purge_queue')));
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('purge worker retains failed tasks and schedules a retry', async () => {
  const statements = [];
  const task = { id: 'task-2', storage_path: validPath, attempts: 2 };
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT id, storage_path, attempts')) return { rows: [task], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  const pool = {
    query: async () => ({ rows: [{ id: task.id }] }),
    connect: async () => client
  };
  const { processPrivatePhotoPurgeBatch } = await import('./photoPurge.js');
  const summary = await processPrivatePhotoPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; }
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 0, retried: 1, failures: 1 });
  const retry = statements.find(item => item.sql.startsWith('UPDATE private_photo_purge_queue'));
  assert.ok(retry);
  assert.equal(retry.params[1], 3);
  assert.equal(retry.params[3], 'EACCES');
  assert.equal(statements.at(-1).sql, 'COMMIT');
});


test('photo purge runner rejects a symlinked storage root and accepts a real directory', async () => {
  const { runPrivatePhotoPurge } = await import('./process-private-photo-purge.js');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-photo-purge-'));
  const realRoot = path.join(tempRoot, 'real');
  const linkedRoot = path.join(tempRoot, 'linked');
  const pool = { query: async () => ({ rows: [] }) };
  try {
    await (await import('node:fs/promises')).mkdir(realRoot);
    await symlink(realRoot, linkedRoot, 'dir');
    await assert.rejects(
      runPrivatePhotoPurge({ storageRoot: linkedRoot, pool }),
      /not a real directory/
    );
    const summary = await runPrivatePhotoPurge({ storageRoot: realRoot, pool });
    assert.deepEqual(summary, { scanned: 0, deleted: 0, retried: 0, failures: 0 });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});


test('photo purge process exit code reports deletion failures to the scheduler', () => {
  assert.equal(privatePhotoPurgeExitCode({ failures: 0 }), 0);
  assert.equal(privatePhotoPurgeExitCode({ failures: 1 }), 2);
  assert.equal(privatePhotoPurgeExitCode({ failures: 4 }), 2);
  assert.equal(privatePhotoPurgeExitCode(undefined), 0);
});


test('photo purge skips a queue row already locked by another worker', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql.replace(/\\s+/g, ' ').trim());
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool = {
    async query() { return { rows: [{ id: 'claimed-by-other-worker' }] }; },
    async connect() { return client; }
  };
  let unlinkCalls = 0;
  const { processPrivatePhotoPurgeBatch } = await import('./photoPurge.js');
  const summary = await processPrivatePhotoPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { unlinkCalls += 1; }
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 0, retried: 0, failures: 0 });
  assert.equal(unlinkCalls, 0);
  assert.ok(statements.includes('COMMIT'));
  assert.equal(statements.some(sql => sql.startsWith('DELETE FROM private_photo_purge_queue')), false);
});

test('photo purge safely resumes when the worker loses its commit after unlink', async () => {
  let queueExists = true;
  let attempts = 0;
  let commitCount = 0;
  let unlinkCount = 0;
  const { processPrivatePhotoPurgeBatch } = await import('./photoPurge.js');
  const pool = {
    async query() {
      return { rows: queueExists ? [{ id: 'crash-retry' }] : [] };
    },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('SELECT id, storage_path, attempts')) {
            return { rows: queueExists ? [{ id: 'crash-retry', storage_path: validPath, attempts }] : [] };
          }
          if (sql.startsWith('UPDATE private_photo_purge_queue')) {
            attempts += 1;
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('DELETE FROM private_photo_purge_queue')) {
            queueExists = false;
            return { rows: [], rowCount: 1 };
          }
          if (sql === 'COMMIT') {
            commitCount += 1;
            if (commitCount === 1) throw new Error('simulated_connection_loss_before_commit');
            return { rows: [] };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {}
      };
    }
  };
  const first = await processPrivatePhotoPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { unlinkCount += 1; }
  });
  assert.deepEqual(first, { scanned: 1, deleted: 0, retried: 1, failures: 1 });
  assert.equal(queueExists, true);
  assert.equal(unlinkCount, 1);

  const second = await processPrivatePhotoPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => {
      const error = new Error('file was already removed by the previous worker');
      error.code = 'ENOENT';
      throw error;
    }
  });
  assert.deepEqual(second, { scanned: 1, deleted: 1, retried: 0, failures: 0 });
  assert.equal(queueExists, false);
  assert.equal(unlinkCount, 1);
});
