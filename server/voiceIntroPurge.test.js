import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizePrivateVoiceIntroPurgeBatchSize,
  privateVoiceIntroPurgeRetryDelayMs,
  queuePrivateVoiceIntroPurges,
  processPrivateVoiceIntroPurgeBatch
} from './voiceIntroStorage.js';

const root = path.resolve('/srv/vow/private-voice-intros');
const validPath = path.join(root, randomUUID() + '.enc');

test('private voice intro purge batch size and retry delay are bounded', () => {
  assert.equal(normalizePrivateVoiceIntroPurgeBatchSize('25'), 25);
  for (const value of [0, -1, 1001, 'nope', 1.5]) assert.throws(() => normalizePrivateVoiceIntroPurgeBatchSize(value), RangeError);
  assert.equal(privateVoiceIntroPurgeRetryDelayMs(0), 60_000);
  assert.equal(privateVoiceIntroPurgeRetryDelayMs(1), 120_000);
  assert.equal(privateVoiceIntroPurgeRetryDelayMs(20), 6 * 60 * 60 * 1000);
  assert.throws(() => privateVoiceIntroPurgeRetryDelayMs(-1), RangeError);
});

test('queueing deduplicates encrypted file paths and safely handles empty input', async () => {
  const calls = [];
  const client = { query: async (...args) => { calls.push(args); return { rowCount: 1 }; } };
  assert.equal(await queuePrivateVoiceIntroPurges(client, []), 0);
  assert.equal(calls.length, 0);
  assert.equal(await queuePrivateVoiceIntroPurges(client, [validPath, validPath, null]), 1);
  assert.deepEqual(calls[0][1], [[validPath]]);
});

test('purge worker deletes encrypted file and queue row transactionally', async () => {
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
  const pool = { query: async () => ({ rows: [{ id: task.id }] }), connect: async () => client };
  const removed = [];
  const summary = await processPrivateVoiceIntroPurgeBatch(pool, { storageRoot: root, unlinkFile: async file => removed.push(file) });
  assert.deepEqual(summary, { scanned: 1, deleted: 1, retried: 0, failures: 0 });
  assert.deepEqual(removed, [validPath]);
  assert.ok(statements.some(item => item.sql.startsWith('DELETE FROM private_voice_intro_purge_queue')));
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('purge worker retains failed encrypted files and schedules a bounded retry', async () => {
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
  const pool = { query: async () => ({ rows: [{ id: task.id }] }), connect: async () => client };
  const summary = await processPrivateVoiceIntroPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; }
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 0, retried: 1, failures: 1 });
  const retry = statements.find(item => item.sql.startsWith('UPDATE private_voice_intro_purge_queue'));
  assert.ok(retry);
  assert.equal(retry.params[1], 3);
  assert.equal(retry.params[3], 'EACCES');
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('purge worker treats an already absent encrypted file as idempotently deleted', async () => {
  const task = { id: 'task-enoent', storage_path: validPath, attempts: 0 };
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: sql.replace(/\\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT id, storage_path, attempts')) return { rows: [task], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  const pool = { query: async () => ({ rows: [{ id: task.id }] }), connect: async () => client };
  const summary = await processPrivateVoiceIntroPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { const error = new Error('already removed'); error.code = 'ENOENT'; throw error; }
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 1, retried: 0, failures: 0 });
  assert.ok(statements.some(item => item.sql.startsWith('DELETE FROM private_voice_intro_purge_queue')));
});

test('purge worker refuses traversal paths without touching files and retries the invalid task', async () => {
  const task = { id: 'task-invalid-path', storage_path: path.resolve(root, '../outside/' + randomUUID() + '.enc'), attempts: 0 };
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: sql.replace(/\\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT id, storage_path, attempts')) return { rows: [task], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  const pool = { query: async () => ({ rows: [{ id: task.id }] }), connect: async () => client };
  let unlinkCalls = 0;
  const summary = await processPrivateVoiceIntroPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { unlinkCalls += 1; }
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 0, retried: 1, failures: 1 });
  assert.equal(unlinkCalls, 0);
  const retry = statements.find(item => item.sql.startsWith('UPDATE private_voice_intro_purge_queue'));
  assert.ok(retry);
  assert.equal(retry.params[3], 'VOICE_INTRO_PATH_INVALID');
});
