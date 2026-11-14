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


test('voice purge skips a queue row already locked by another worker', async () => {
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
  const summary = await processPrivateVoiceIntroPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { unlinkCalls += 1; }
  });
  assert.deepEqual(summary, { scanned: 1, deleted: 0, retried: 0, failures: 0 });
  assert.equal(unlinkCalls, 0);
  assert.ok(statements.includes('COMMIT'));
  assert.equal(statements.some(sql => sql.startsWith('DELETE FROM private_voice_intro_purge_queue')), false);
});

test('voice purge safely resumes when the worker loses its commit after unlink', async () => {
  let queueExists = true;
  let attempts = 0;
  let commitCount = 0;
  let unlinkCount = 0;
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
          if (sql.startsWith('UPDATE private_voice_intro_purge_queue')) {
            attempts += 1;
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('DELETE FROM private_voice_intro_purge_queue')) {
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
  const first = await processPrivateVoiceIntroPurgeBatch(pool, {
    storageRoot: root,
    unlinkFile: async () => { unlinkCount += 1; }
  });
  assert.deepEqual(first, { scanned: 1, deleted: 0, retried: 1, failures: 1 });
  assert.equal(queueExists, true);
  assert.equal(unlinkCount, 1);

  const second = await processPrivateVoiceIntroPurgeBatch(pool, {
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
