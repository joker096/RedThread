import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
  assert.equal(privatePhotoPurgeRetryDelayMs(8), 6 * 60 * 60 * 1000);
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
