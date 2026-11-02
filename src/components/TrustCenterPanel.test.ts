import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldOfferL3PurgeRetry, validL3Consent } from './TrustCenterPanel.tsx';

const validConsent = {
  version: 1,
  notice: {
    version: 1,
    title: 'Consent to L3 video identity verification',
    text: 'Explicit consent to process a 30–60 second verification video.'
  },
  accepted: true,
  enabled: true,
  grantedAt: '2026-11-02T12:00:00.000Z',
  withdrawnAt: null,
  purgeStatus: 'complete',
  pendingPurgeJobs: 0,
  failedPurgeJobs: 0
};

test('accepts a complete current L3 consent response', () => {
  assert.equal(validL3Consent(validConsent), true);
});

test('rejects stale or mismatched L3 consent notice versions', () => {
  assert.equal(validL3Consent({ ...validConsent, version: 2 }), false);
  assert.equal(validL3Consent({
    ...validConsent,
    notice: { ...validConsent.notice, version: 2 }
  }), false);
});

test('rejects malformed consent timestamps, purge states and counters', () => {
  for (const value of [
    { ...validConsent, grantedAt: 'not-a-date' },
    { ...validConsent, withdrawnAt: 123 },
    { ...validConsent, purgeStatus: 'unknown' },
    { ...validConsent, pendingPurgeJobs: -1 },
    { ...validConsent, failedPurgeJobs: 0.5 },
    { ...validConsent, enabled: 'true' },
    { ...validConsent, accepted: 1 },
    null,
    [],
    'consent'
  ]) {
    assert.equal(validL3Consent(value), false);
  }
});

test('accepts an explicitly withdrawn consent with a valid audit timestamp', () => {
  assert.equal(validL3Consent({
    ...validConsent,
    accepted: false,
    withdrawnAt: '2026-11-02T12:30:00.000Z',
    purgeStatus: 'pending',
    pendingPurgeJobs: 1
  }), true);
});

test('offers a retry only when consent is withdrawn and physical media purge has failed', () => {
  assert.equal(shouldOfferL3PurgeRetry({
    ...validConsent,
    accepted: false,
    purgeStatus: 'failed',
    failedPurgeJobs: 1
  }), true);
  assert.equal(shouldOfferL3PurgeRetry({
    ...validConsent,
    accepted: false,
    purgeStatus: 'pending',
    pendingPurgeJobs: 1
  }), false);
  assert.equal(shouldOfferL3PurgeRetry({
    ...validConsent,
    accepted: true,
    purgeStatus: 'failed',
    failedPurgeJobs: 1
  }), false);
  assert.equal(shouldOfferL3PurgeRetry(null), false);
});
