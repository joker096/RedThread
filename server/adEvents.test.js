import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdEventCollectionEnabled, AD_CLICK_CAP_24H, AD_IMPRESSION_CAP_24H, classifyDuplicateAdEvent, evaluateAdEventBillingEligibility, evaluateAdEventFrequency, hasExplicitAdConsent, validateAdEventPayload } from './adEvents.js';

test('ad event collection stays disabled until trusted delivery receipts exist', () => {
  assert.equal(isAdEventCollectionEnabled(), false);
  // Legacy/environment input must never be able to bypass the delivery-proof gate.
  assert.equal(isAdEventCollectionEnabled('true'), false);
  assert.equal(isAdEventCollectionEnabled('false'), false);
});

test('ad event payload accepts valid impression and click events', () => {
  const base = { eventId: 'b5e8d1a0-5c2b-4f39-8f04-3db6a1e32d88', campaignId: 'restaurant_summer-1' };
  assert.deepEqual(validateAdEventPayload({ ...base, eventType: 'impression' }), {
    ok: true,
    value: { ...base, eventType: 'impression' }
  });
  assert.equal(validateAdEventPayload({ ...base, eventType: 'click' }).ok, true);
});

test('ad event validation rejects malformed ids, campaigns and event types', () => {
  assert.equal(validateAdEventPayload(null).error, 'invalid_ad_event');
  assert.equal(validateAdEventPayload({ eventId: 'not-a-uuid', campaignId: 'ad', eventType: 'impression' }).error, 'invalid_event_id');
  assert.equal(validateAdEventPayload({ eventId: 'b5e8d1a0-5c2b-4f39-8f04-3db6a1e32d88', campaignId: '../bad', eventType: 'impression' }).error, 'invalid_campaign_id');
  assert.equal(validateAdEventPayload({ eventId: 'b5e8d1a0-5c2b-4f39-8f04-3db6a1e32d88', campaignId: 'valid', eventType: 'view' }).error, 'invalid_event_type');
});

test('server-side impression frequency cap is intentionally bounded', () => {
  assert.equal(AD_IMPRESSION_CAP_24H, 3);
  assert.equal(AD_CLICK_CAP_24H, 5);
});


test('ad engagement consent fails closed when preferences are absent or disabled', () => {
  assert.equal(hasExplicitAdConsent([]), false);
  assert.equal(hasExplicitAdConsent(null), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: false }]), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: null }]), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: 'true' }]), false);
});

test('ad engagement consent requires a persisted boolean opt-in', () => {
  assert.equal(hasExplicitAdConsent([{ ads_consent: true, consent_version: 1 }]), true);
  assert.equal(hasExplicitAdConsent([{ ads_consent: true, consent_version: 0 }]), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: true }]), false);
});


test('ad event idempotency accepts only an exact retry by the same user', () => {
  const event = {
    userId: 'user-a',
    campaignId: 'summer-cafe',
    eventType: 'impression'
  };
  const row = {
    user_id: 'user-a',
    campaign_id: 'summer-cafe',
    event_type: 'impression'
  };
  assert.equal(classifyDuplicateAdEvent(null, event), 'new');
  assert.equal(classifyDuplicateAdEvent(row, event), 'duplicate');
  assert.equal(classifyDuplicateAdEvent({ ...row, user_id: 'user-b' }, event), 'conflict');
  assert.equal(classifyDuplicateAdEvent({ ...row, campaign_id: 'other-campaign' }, event), 'conflict');
  assert.equal(classifyDuplicateAdEvent({ ...row, event_type: 'click' }, event), 'conflict');
  assert.equal(classifyDuplicateAdEvent({ ...row, user_id: 'user-a' }, { ...event, userId: 'user-b' }), 'conflict');
});


test('client-provided billing claims cannot make events billable before trusted verification exists', () => {
  const event = { event_type: 'impression' };
  assert.deepEqual(evaluateAdEventBillingEligibility({ event }), {
    billable: false, reason: 'billing_pipeline_unavailable'
  });
  assert.deepEqual(evaluateAdEventBillingEligibility({
    event, campaignApproved: true, viewabilityVerified: true,
    invalidTrafficChecked: true, attributionValid: true, proofSource: 'trusted_server_measurement'
  }), { billable: false, reason: 'billing_pipeline_unavailable' });
  assert.deepEqual(evaluateAdEventBillingEligibility({
    event, campaignApproved: true, viewabilityVerified: true,
    invalidTrafficChecked: true, attributionValid: true, proofSource: 'client'
  }), { billable: false, reason: 'billing_pipeline_unavailable' });
  assert.deepEqual(evaluateAdEventBillingEligibility({
    event: { event_type: 'unknown' }, campaignApproved: true, viewabilityVerified: true,
    invalidTrafficChecked: true, attributionValid: true, proofSource: 'trusted_server_measurement'
  }), { billable: false, reason: 'invalid_event' });
});


test('ad frequency policy enforces impression and click caps from persisted counts', () => {
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'impression', impressionCount: 2, clickCount: 0 }), {
    allowed: true, reason: null
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'impression', impressionCount: 3, clickCount: 0 }), {
    allowed: false, reason: 'ad_frequency_cap_reached'
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'click', impressionCount: 1, clickCount: 4 }), {
    allowed: true, reason: null
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'click', impressionCount: 1, clickCount: 5 }), {
    allowed: false, reason: 'ad_click_frequency_cap_reached'
  });
});

test('ad frequency policy rejects non-safe-integer values for either persisted counter', () => {
  for (const invalidCount of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5, -1, null]) {
    assert.deepEqual(
      evaluateAdEventFrequency({ eventType: 'impression', impressionCount: invalidCount, clickCount: 0 }),
      { allowed: false, reason: 'invalid_event_counts' },
      `invalid impression count: ${String(invalidCount)}`
    );
    assert.deepEqual(
      evaluateAdEventFrequency({ eventType: 'click', impressionCount: 1, clickCount: invalidCount }),
      { allowed: false, reason: 'invalid_event_counts' },
      `invalid click count: ${String(invalidCount)}`
    );
  }
});

test('ad frequency policy rejects null and non-object input without throwing', () => {
  for (const input of [null, [], 'impression', 3]) {
    assert.deepEqual(evaluateAdEventFrequency(input), {
      allowed: false, reason: 'invalid_event_type'
    });
  }
});

test('ad frequency policy fails closed when either persisted counter is missing', () => {
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'impression', clickCount: 0 }), {
    allowed: false, reason: 'invalid_event_counts'
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'impression', impressionCount: 0 }), {
    allowed: false, reason: 'invalid_event_counts'
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'click', impressionCount: 1 }), {
    allowed: false, reason: 'invalid_event_counts'
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'click', clickCount: 0 }), {
    allowed: false, reason: 'invalid_event_counts'
  });
});

test('ad click policy requires an impression and rejects invalid persisted counts', () => {
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'click', impressionCount: 0, clickCount: 0 }), {
    allowed: false, reason: 'impression_required_before_click'
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'impression', impressionCount: -1 }), {
    allowed: false, reason: 'invalid_event_counts'
  });
  assert.deepEqual(evaluateAdEventFrequency({ eventType: 'unknown' }), {
    allowed: false, reason: 'invalid_event_type'
  });
});
