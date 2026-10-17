import test from 'node:test';
import assert from 'node:assert/strict';
import { AD_IMPRESSION_CAP_24H, validateAdEventPayload } from './adEvents.js';

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
