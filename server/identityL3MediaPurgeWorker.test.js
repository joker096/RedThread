import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIdentityL3PurgeBatchSize,
  identityL3PurgeRetryDelayMs
} from './identityL3MediaPurgeWorker.js';

test('identity L3 purge batch size is bounded', () => {
  assert.equal(normalizeIdentityL3PurgeBatchSize('25'), 25);
  assert.throws(() => normalizeIdentityL3PurgeBatchSize(0), /l3_purge_batch_size_invalid/);
  assert.throws(() => normalizeIdentityL3PurgeBatchSize(501), /l3_purge_batch_size_invalid/);
});

test('identity L3 purge retry delay grows exponentially and is capped', () => {
  assert.equal(identityL3PurgeRetryDelayMs(1), 15_000);
  assert.equal(identityL3PurgeRetryDelayMs(2), 30_000);
  assert.equal(identityL3PurgeRetryDelayMs(5), 240_000);
  assert.equal(identityL3PurgeRetryDelayMs(20), 6 * 60 * 60 * 1000);
  assert.throws(() => identityL3PurgeRetryDelayMs(0), /l3_purge_attempts_invalid/);
});
