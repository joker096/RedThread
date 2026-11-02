import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_L3_WORKER_MAX_ATTEMPTS,
  IDENTITY_L3_WORKER_LEASE_MS,
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
