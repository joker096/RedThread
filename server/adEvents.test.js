import test from 'node:test';
import assert from 'node:assert/strict';
import { AD_IMPRESSION_CAP_24H, classifyDuplicateAdEvent, hasExplicitAdConsent, validateAdEventPayload } from './adEvents.js';

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
});


test('ad engagement consent fails closed when preferences are absent or disabled', () => {
  assert.equal(hasExplicitAdConsent([]), false);
  assert.equal(hasExplicitAdConsent(null), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: false }]), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: null }]), false);
  assert.equal(hasExplicitAdConsent([{ ads_consent: 'true' }]), false);
});

test('ad engagement consent requires a persisted boolean opt-in', () => {
  assert.equal(hasExplicitAdConsent([{ ads_consent: true }]), true);
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
