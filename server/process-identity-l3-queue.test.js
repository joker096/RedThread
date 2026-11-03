import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_L3_WORKER_MAX_ATTEMPTS,
  IDENTITY_L3_WORKER_LEASE_MS,
  claimIdentityL3Submission,
  processClaimedIdentityL3Submission,
  runIdentityL3WorkerOnce,
  identityL3RetryDelayMs,
  isPermanentIdentityL3ProcessingError,
  IDENTITY_L3_PURGE_MAX_ATTEMPTS,
  identityL3PurgeRetryDelayMs,
  runIdentityL3PurgeOnce
} from './process-identity-l3-queue.js';
import { IdentityL3MediaProcessingError } from './identityL3MediaProcessing.js';

test('L3 worker leases and retry limits are bounded', () => {
  assert.equal(IDENTITY_L3_WORKER_LEASE_MS, 180_000);
  assert.equal(IDENTITY_L3_WORKER_MAX_ATTEMPTS, 5);
  assert.equal(identityL3RetryDelayMs(1), 60_000);
  assert.equal(identityL3RetryDelayMs(2), 120_000);
  assert.equal(identityL3RetryDelayMs(5), 960_000);
  for (const attempt of [0, 6, 1.5, '1']) {
    assert.throws(() => identityL3RetryDelayMs(attempt), RangeError);
  }
});

test('L3 worker retries infrastructure failures but terminally rejects invalid or malicious media', () => {
  assert.equal(
    isPermanentIdentityL3ProcessingError(new IdentityL3MediaProcessingError('l3_media_scanner_unavailable')),
    false
  );
  assert.equal(
    isPermanentIdentityL3ProcessingError(new IdentityL3MediaProcessingError('l3_media_probe_timeout')),
    false
  );
  assert.equal(
    isPermanentIdentityL3ProcessingError(new IdentityL3MediaProcessingError('l3_media_malware_detected')),
    true
  );
  assert.equal(
    isPermanentIdentityL3ProcessingError(new IdentityL3MediaProcessingError('l3_media_format_or_codec_invalid')),
    true
  );
  assert.equal(isPermanentIdentityL3ProcessingError(new Error('unknown failure')), false);
});

function fakeClient({ active = true, lockedRow = true, updateRowCount = 1 } = {}) {
  const calls = [];
  return {
    calls,
    released: false,
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ sql: statement, params });
      if (statement.includes('SELECT id FROM users')) {
        return { rows: active ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] : [], rowCount: active ? 1 : 0 };
      }
      if (statement.includes('SELECT id, user_id, status, storage_object_key')) {
        return {
          rows: lockedRow ? [{
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'uploaded',
            storage_object_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            media_mime_type: 'video/mp4',
            processing_attempts: 0
          }] : [],
          rowCount: lockedRow ? 1 : 0
        };
      }
      if (statement.includes('UPDATE identity_l3_submissions')) {
        return { rows: updateRowCount ? [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] : [], rowCount: updateRowCount };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { this.released = true; }
  };
}

test('L3 worker skips empty queues without reserving a PostgreSQL connection', async () => {
  let connects = 0;
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { connects += 1; throw new Error('must not connect for an empty queue'); }
  };
  assert.equal(await claimIdentityL3Submission(pool), null);
  assert.equal(connects, 0);
});

test('L3 worker releases the account lock and connection when the account is no longer active', async () => {
  const client = fakeClient({ active: false });
  const pool = {
    async query() {
      return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 };
    },
    async connect() { return client; }
  };
  assert.equal(await claimIdentityL3Submission(pool), null);
  assert.ok(client.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(client.calls.some(call => call.sql.includes('pg_advisory_unlock')));
  assert.equal(client.released, true);
});

test('L3 worker claims under the account safety lock with SKIP LOCKED and a unique fencing token', async () => {
  const client = fakeClient();
  const pool = {
    async query() {
      return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 };
    },
    async connect() { return client; }
  };
  const claim = await claimIdentityL3Submission(pool);
  assert.ok(claim);
  assert.match(claim.leaseToken, /^[0-9a-f-]{36}$/);
  assert.ok(client.calls.some(call => call.sql.includes('pg_advisory_lock')));
  assert.ok(client.calls.some(call => call.sql.includes('FOR UPDATE SKIP LOCKED')));
  assert.ok(client.calls.some(call => call.sql.includes('processing_lease_token = $2')));
  assert.equal(client.released, false, 'the session lock and connection remain held during processing');
  await claim.client.query('SELECT pg_advisory_unlock(hashtext($1))', [claim.lockKey]);
  claim.client.release();
});

test('L3 worker only advances a submission after processing and fences completion by lease token', async () => {
  const client = fakeClient();
  const claim = {
    client,
    leaseToken: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    row: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      storage_object_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      media_mime_type: 'video/mp4',
      processing_attempts: 1
    }
  };
  const result = await processClaimedIdentityL3Submission({}, claim, {
    storageRoot: '/private/l3',
    tempRoot: '/private/l3-scratch',
    encryptionKey: '8f'.repeat(32),
    heartbeatMs: 60_000,
    processMedia: async input => {
      assert.equal(input.objectKey, claim.row.storage_object_key);
      assert.equal(input.tempRoot, '/private/l3-scratch',
        'the processor must not fall back to the container default /tmp');
      assert.equal(input.declaredMimeType, 'video/mp4');
      return { durationSeconds: 42, sizeBytes: 1024 };
    }
  });
  assert.deepEqual(result, { status: 'pending_review', durationSeconds: 42 });
  const completion = client.calls.find(call => call.sql.includes("SET status = 'pending_review'"));
  assert.ok(completion);
  assert.match(completion.sql, /processing_lease_token = \$2/);
  assert.match(completion.sql, /processing_lease_expires_at > statement_timestamp\(\)/);
  assert.equal(completion.params[2], 42);
});

test('L3 worker discards a connection when transaction rollback fails', async () => {
  const calls = [];
  let submissionUpdates = 0;
  let releasedWithError = null;
  const client = {
    async query(sql) {
      const statement = String(sql);
      calls.push(statement);
      if (statement.includes('SELECT id FROM users')) {
        return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 };
      }
      if (statement.includes('SELECT id, user_id, status, storage_object_key')) {
        return {
          rows: [{
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'uploaded',
            storage_object_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            media_mime_type: 'video/mp4',
            processing_attempts: 0
          }],
          rowCount: 1
        };
      }
      if (statement.includes('UPDATE identity_l3_submissions')) {
        submissionUpdates += 1;
        if (submissionUpdates === 1) {
          return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], rowCount: 1 };
        }
        throw new Error('completion_write_failed');
      }
      if (statement === 'ROLLBACK') throw new Error('rollback_failed');
      return { rows: [], rowCount: 0 };
    },
    release(error) { releasedWithError = error || null; }
  };
  const pool = {
    async query() {
      return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 };
    },
    async connect() { return client; }
  };

  await assert.rejects(
    runIdentityL3WorkerOnce(pool, {
      storageRoot: '/private/l3',
      tempRoot: '/private/l3-scratch',
      encryptionKey: '8f'.repeat(32),
      heartbeatMs: 60_000,
      processMedia: async () => ({ durationSeconds: 42, sizeBytes: 1024 })
    }),
    error => error.message === 'completion_write_failed' &&
      error.discardClient === true &&
      error.rollbackError?.message === 'rollback_failed'
  );
  assert.ok(releasedWithError,
    'the PostgreSQL client must be destroyed rather than returned to the pool');
  assert.ok(!calls.some(statement => statement.includes('pg_advisory_unlock')),
    'do not issue more SQL on a connection whose transaction state is uncertain');
});

test('L3 worker schedules infrastructure retries but terminally fails malware detections', async () => {
  const makeClaim = () => ({
    client: fakeClient(),
    leaseToken: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    row: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      storage_object_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      media_mime_type: 'video/mp4',
      processing_attempts: 1
    }
  });
  const options = {
    storageRoot: '/private/l3',
    tempRoot: '/private/l3-scratch',
    encryptionKey: '8f'.repeat(32),
    heartbeatMs: 60_000
  };
  const retryClaim = makeClaim();
  const retry = await processClaimedIdentityL3Submission({}, retryClaim, {
    ...options,
    processMedia: async () => { throw new IdentityL3MediaProcessingError('l3_media_scanner_unavailable'); }
  });
  assert.equal(retry.status, 'retry_scheduled');
  assert.equal(retry.retryDelay, 60_000);
  const retryUpdate = retryClaim.client.calls.find(call => call.sql.includes('UPDATE identity_l3_submissions'));
  assert.match(retryUpdate.sql, /ELSE 'processing'/);

  const malwareClaim = makeClaim();
  const failed = await processClaimedIdentityL3Submission({}, malwareClaim, {
    ...options,
    processMedia: async () => { throw new IdentityL3MediaProcessingError('l3_media_malware_detected'); }
  });
  assert.equal(failed.status, 'failed');
  const failedUpdate = malwareClaim.client.calls.find(call => call.sql.includes('UPDATE identity_l3_submissions'));
  assert.match(failedUpdate.sql, /THEN 'failed'/);
});

function fakePurgePool({ job = true } = {}) {
  const calls = [];
  let released = false;
  const client = {
    calls,
    get released() { return released; },
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ sql: statement, params });
      if (statement.includes('SELECT j.id, j.submission_id, j.user_id, j.attempts')) {
        return {
          rows: job ? [{
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            submission_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            attempts: 0,
            submission_status: 'withdrawn',
            storage_object_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            media_purged_at: null
          }] : [],
          rowCount: job ? 1 : 0
        };
      }
      if (statement.includes('UPDATE identity_l3_submissions')) {
        return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], rowCount: 1 };
      }
      if (statement.includes('UPDATE identity_l3_media_purge_jobs') &&
          statement.includes("SET status = 'completed'")) {
        return { rows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; }
  };
  return {
    client,
    pool: {
      async query() {
        return {
          rows: job ? [{
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          }] : [],
          rowCount: job ? 1 : 0
        };
      },
      async connect() { return client; }
    }
  };
}

test('L3 purge retries use bounded exponential delays', () => {
  assert.equal(IDENTITY_L3_PURGE_MAX_ATTEMPTS, 5);
  assert.equal(identityL3PurgeRetryDelayMs(1), 60_000);
  assert.equal(identityL3PurgeRetryDelayMs(2), 120_000);
  assert.equal(identityL3PurgeRetryDelayMs(5), 960_000);
  for (const attempt of [0, 6, 1.5, '1']) {
    assert.throws(() => identityL3PurgeRetryDelayMs(attempt), RangeError);
  }
});

test('L3 purge worker deletes encrypted media under the account lock and clears the DB key only after unlink', async () => {
  const { pool, client } = fakePurgePool();
  const deleted = [];
  const result = await runIdentityL3PurgeOnce(pool, {
    storageRoot: '/private/l3',
    deleteObject: async input => { deleted.push(input); return true; }
  });
  assert.deepEqual(result, {
    processed: true,
    purgeJobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status: 'completed'
  });
  assert.deepEqual(deleted, [{
    objectKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    root: '/private/l3'
  }]);
  const clearIndex = client.calls.findIndex(call => call.sql.includes('UPDATE identity_l3_submissions'));
  const completeIndex = client.calls.findIndex(call =>
    call.sql.includes("SET status = 'completed'") && call.sql.includes('identity_l3_media_purge_jobs')
  );
  const deletedAccountMetadataCleanupIndex = client.calls.findIndex(call =>
    call.sql.includes('DELETE FROM identity_l3_submissions AS s') &&
    call.sql.includes("u.status = 'deleted'")
  );
  assert.ok(clearIndex >= 0 && completeIndex > clearIndex);
  assert.ok(
    deletedAccountMetadataCleanupIndex > completeIndex,
    'deleted-account L3 metadata cleanup must run only after the purge job is marked completed'
  );
  assert.ok(client.calls.some(call => call.sql.includes('pg_advisory_lock')));
  assert.ok(client.calls.some(call => call.sql.includes('pg_advisory_unlock')));
  assert.equal(client.released, true);
});

test('L3 purge worker retries storage failures without clearing the encrypted object key', async () => {
  const { pool, client } = fakePurgePool();
  const result = await runIdentityL3PurgeOnce(pool, {
    storageRoot: '/private/l3',
    deleteObject: async () => { throw Object.assign(new Error('storage unavailable'), { code: 'l3_storage_root_unsafe' }); }
  });
  assert.equal(result.status, 'retry_scheduled');
  assert.equal(result.errorCode, 'l3_storage_root_unsafe');
  assert.equal(client.calls.some(call => call.sql.includes('UPDATE identity_l3_submissions')), false);
  const retry = client.calls.find(call =>
    call.sql.includes('UPDATE identity_l3_media_purge_jobs') && call.sql.includes('SET status = $3')
  );
  assert.equal(retry.params[2], 'queued');
  assert.equal(retry.params[3], 60_000);
});

test('L3 purge worker does not connect when no deletion is due', async () => {
  let connects = 0;
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { connects += 1; throw new Error('unexpected connection'); }
  };
  assert.deepEqual(await runIdentityL3PurgeOnce(pool), { processed: false });
  assert.equal(connects, 0);
});
