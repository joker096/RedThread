import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { processIdentityL3MediaPurgeBatch } from './identityL3MediaPurgeWorker.js';

const { Pool } = pg;

test('identity L3 purge worker clears encrypted object key only after deletion and records completion', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const userId = randomUUID();
  const submissionId = randomUUID();
  const objectKey = randomUUID();
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-l3-purge-'));
  let fixtureCreated = false;
  let deleteCalls = 0;
  try {
    await pool.query(
      "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, 'member', 'active', NOW())",
      [userId, 'l3-purge-worker-' + userId + '@example.invalid']
    );
    await pool.query(
      `INSERT INTO identity_l3_submissions (id, user_id, status, storage_object_key)
       VALUES ($1, $2, 'failed', $3)`,
      [submissionId, userId, objectKey]
    );
    fixtureCreated = true;

    const summary = await processIdentityL3MediaPurgeBatch(pool, {
      storageRoot,
      batchSize: 1,
      requireMount: false,
      deleteObject: async ({ objectKey: requestedKey, root }) => {
        deleteCalls += 1;
        assert.equal(requestedKey, objectKey);
        assert.equal(root, storageRoot);
        return true;
      }
    });
    assert.equal(deleteCalls, 1);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.deleted, 1);
    assert.equal(summary.failures, 0);

    const state = await pool.query(
      `SELECT s.storage_object_key, s.media_purged_at,
              j.status AS purge_status, j.completed_at, j.lease_token,
              j.lease_expires_at
         FROM identity_l3_submissions s
         JOIN identity_l3_media_purge_jobs j
           ON j.submission_id = s.id AND j.user_id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [submissionId, userId]
    );
    assert.equal(state.rowCount, 1);
    assert.equal(state.rows[0].storage_object_key, null);
    assert.ok(state.rows[0].media_purged_at);
    assert.equal(state.rows[0].purge_status, 'completed');
    assert.ok(state.rows[0].completed_at);
    assert.equal(state.rows[0].lease_token, null);
    assert.equal(state.rows[0].lease_expires_at, null);
  } finally {
    if (fixtureCreated) {
      const state = await pool.query(
        'SELECT storage_object_key, status FROM identity_l3_submissions WHERE id = $1 AND user_id = $2',
        [submissionId, userId]
      ).catch(() => ({ rows: [] }));
      if (state.rows[0]?.storage_object_key === null) {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
      }
    }
    await rm(storageRoot, { recursive: true, force: true });
    await pool.end();
  }
});

test('identity L3 purge worker retries deletion failures without clearing the submission reference', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const userId = randomUUID();
  const submissionId = randomUUID();
  const objectKey = randomUUID();
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-l3-purge-retry-'));
  let fixtureCreated = false;
  try {
    await pool.query(
      "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, 'member', 'active', NOW())",
      [userId, 'l3-purge-retry-' + userId + '@example.invalid']
    );
    await pool.query(
      `INSERT INTO identity_l3_submissions (id, user_id, status, storage_object_key)
       VALUES ($1, $2, 'failed', $3)`,
      [submissionId, userId, objectKey]
    );
    fixtureCreated = true;

    const summary = await processIdentityL3MediaPurgeBatch(pool, {
      storageRoot,
      batchSize: 1,
      requireMount: false,
      deleteObject: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    });
    assert.equal(summary.claimed, 1);
    assert.equal(summary.retried, 1);
    assert.equal(summary.failed, 0);
    const state = await pool.query(
      `SELECT s.storage_object_key, s.media_purged_at,
              j.status AS purge_status, j.attempts, j.last_error_code,
              j.lease_token, j.lease_expires_at
         FROM identity_l3_submissions s
         JOIN identity_l3_media_purge_jobs j
           ON j.submission_id = s.id AND j.user_id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [submissionId, userId]
    );
    assert.equal(state.rowCount, 1);
    assert.equal(state.rows[0].storage_object_key, objectKey);
    assert.equal(state.rows[0].media_purged_at, null);
    assert.equal(state.rows[0].purge_status, 'queued');
    assert.equal(state.rows[0].attempts, 1);
    assert.equal(state.rows[0].last_error_code, 'eacces');
    assert.equal(state.rows[0].lease_token, null);
    assert.equal(state.rows[0].lease_expires_at, null);
  } finally {
    if (fixtureCreated) {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
    await rm(storageRoot, { recursive: true, force: true });
    await pool.end();
  }
});
