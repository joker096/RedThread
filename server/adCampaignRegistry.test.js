import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAdCampaignEligibility, isCampaignCountryAllowed, resolveProfileCountryCode } from './adCampaignRegistry.js';

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
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '1' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-10-01T00:00:00' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-02-31T12:00:00Z' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, endsAt: '2026-10-01T12:00:00+14:01' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, creativeVersion: '' }, { now }).reason, 'creative_not_approved');
});

test('campaign registry rejects categories outside the approved allowlist', () => {
  for (const category of ['political', 'unreviewed_health', 'bridal_dress', 'wedding_venue', 'legal', 'family_law']) {
    assert.equal(
      evaluateAdCampaignEligibility({ ...approved, category }, { now }).reason,
      'campaign_category_not_allowed',
      category
    );
  }
});


test('campaign country allowlists fail closed for missing, unknown and non-matching countries', () => {
  assert.equal(isCampaignCountryAllowed(['GE'], 'GE'), true);
  assert.equal(isCampaignCountryAllowed(['GE'], 'US'), false);
  assert.equal(isCampaignCountryAllowed([], 'GE'), false);
  assert.equal(isCampaignCountryAllowed(['GE'], null), false);
  assert.equal(isCampaignCountryAllowed(['GE'], 'Georgia'), false);
});

test('profile country normalization supports known aliases and fails closed for unknown labels', () => {
  assert.equal(resolveProfileCountryCode('Грузия'), 'GE');
  assert.equal(resolveProfileCountryCode('Georgia'), 'GE');
  assert.equal(resolveProfileCountryCode('GE'), 'GE');
  assert.equal(resolveProfileCountryCode('Unlisted country'), null);
  assert.equal(resolveProfileCountryCode(''), null);
});
