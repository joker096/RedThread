import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_L3_WORKER_MAX_ATTEMPTS,
  IDENTITY_L3_WORKER_LEASE_MS,
  claimIdentityL3Submission,
  processClaimedIdentityL3Submission,
  identityL3RetryDelayMs,
  isPermanentIdentityL3ProcessingError
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
    encryptionKey: '8f'.repeat(32),
    heartbeatMs: 60_000,
    processMedia: async input => {
      assert.equal(input.objectKey, claim.row.storage_object_key);
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
