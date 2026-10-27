import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAdCampaignEligibility } from './adCampaignRegistry.js';

const now = Date.parse('2026-10-27T10:00:00.000Z');
const approved = {
  id: 'cafe_autumn_01',
  status: 'approved',
  advertiserVerified: true,
  creativeApproved: true,
  creativeVersion: 'creative-v3',
  category: 'cafe',
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-11-01T00:00:00.000Z'
};

test('campaign registry denies unknown campaign ids', () => {
  assert.deepEqual(evaluateAdCampaignEligibility(null, { now }), { eligible: false, reason: 'campaign_unknown' });
});

test('campaign registry allows only approved, verified, active campaigns', () => {
  assert.equal(evaluateAdCampaignEligibility(approved, { now }).eligible, true);
  assert.equal(evaluateAdCampaignEligibility({ ...approved, advertiserVerified: false }, { now }).reason, 'advertiser_not_verified');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, creativeApproved: false }, { now }).reason, 'creative_not_approved');
});

test('campaign registry rejects pending, paused, rejected and expired statuses', () => {
  for (const status of ['pending', 'paused', 'rejected', 'expired']) {
    assert.equal(evaluateAdCampaignEligibility({ ...approved, status }, { now }).eligible, false, status);
  }
});

test('campaign registry rejects campaigns outside their validity window', () => {
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-10-27T10:01:00.000Z' }, { now }).reason, 'campaign_not_started');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, endsAt: '2026-10-27T10:00:00.000Z' }, { now }).reason, 'campaign_expired');
});

test('campaign registry rejects malformed windows and missing creative version', () => {
  assert.equal(evaluateAdCampaignEligibility({ ...approved, endsAt: 'invalid' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, creativeVersion: '' }, { now }).reason, 'creative_not_approved');
});

test('campaign registry rejects categories outside the approved allowlist', () => {
  assert.equal(evaluateAdCampaignEligibility({ ...approved, category: 'political' }, { now }).reason, 'campaign_category_not_allowed');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, category: 'unreviewed_health' }, { now }).reason, 'campaign_category_not_allowed');
});
