import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALLOWED_AD_CAMPAIGN_CATEGORIES, VALID_AD_CAMPAIGN_STATUSES, evaluateAdCampaignEligibility, isCampaignCountryAllowed, resolveProfileCountryCode } from './adCampaignRegistry.js';

const now = Date.parse('2026-10-27T10:00:00.000Z');
const approved = {
  id: 'cafe_autumn_01',
  status: 'approved',
  active: true,
  advertiserVerified: true,
  creativeApproved: true,
  creativeVersion: 'creative-v3',
  category: 'cafe',
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-11-01T00:00:00.000Z'
};

test('campaign category allowlist matches the database constraint', () => {
  const migration = readFileSync(new URL('./migrations/039_ad_campaign_category_allowlist.sql', import.meta.url), 'utf8');
  const constraint = migration.match(/CHECK \(category IN \(([\s\S]*?)\) NOT VALID\)/);
  assert.ok(constraint, 'migration must define the campaign category allowlist');
  const databaseCategories = [...constraint[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
  assert.deepEqual(databaseCategories, [...ALLOWED_AD_CAMPAIGN_CATEGORIES]);
});

test('campaign registry denies missing, empty and whitespace-only campaign ids', () => {
  for (const id of [undefined, null, '', '   ', '\t\n']) {
    assert.equal(
      evaluateAdCampaignEligibility({ ...approved, id }, { now }).reason,
      'campaign_unknown',
      JSON.stringify(id)
    );
  }
});

test('campaign registry denies unknown campaign ids', () => {
  assert.deepEqual(evaluateAdCampaignEligibility(null, { now }), { eligible: false, reason: 'campaign_unknown' });
});

test('campaign registry allows only approved, verified, active campaigns', () => {
  assert.equal(evaluateAdCampaignEligibility(approved, { now }).eligible, true);
  assert.equal(evaluateAdCampaignEligibility({ ...approved, active: false }, { now }).reason, 'campaign_not_active');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, active: undefined }, { now }).reason, 'campaign_not_active');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, advertiserVerified: false }, { now }).reason, 'advertiser_not_verified');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, creativeApproved: false }, { now }).reason, 'creative_not_approved');
});

test('campaign registry rejects statuses outside the declared status set', () => {
  assert.ok(VALID_AD_CAMPAIGN_STATUSES.includes('approved'));
  assert.equal(evaluateAdCampaignEligibility({ ...approved, status: 'unknown' }, { now }).reason, 'campaign_status_invalid');
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

test('campaign registry validates its clock and includes the exact start boundary', () => {
  assert.equal(evaluateAdCampaignEligibility(approved, { now: Number.NaN }).reason, 'invalid_validation_clock');
  assert.equal(evaluateAdCampaignEligibility(approved, { now: Infinity }).reason, 'invalid_validation_clock');
  assert.equal(evaluateAdCampaignEligibility(approved, { now: -Infinity }).reason, 'invalid_validation_clock');
  assert.equal(
    evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-10-27T10:00:00.000Z' }, { now }).eligible,
    true,
    'a campaign is eligible at its exact start instant'
  );
});

test('campaign registry rejects malformed windows and missing creative version', () => {
  assert.equal(evaluateAdCampaignEligibility({ ...approved, endsAt: 'invalid' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '1' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-10-01T00:00:00' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-02-31T12:00:00Z' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, endsAt: '2026-10-01T12:00:00+14:01' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-10-01T00:00:00+14:00', endsAt: '2026-11-01T00:00:00+14:00' }, { now }).eligible, true);
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '2026-10-01T00:00:00+15:00' }, { now }).reason, 'campaign_window_invalid');
  assert.equal(evaluateAdCampaignEligibility({ ...approved, startsAt: '0099-01-01T00:00:00Z', endsAt: '0099-12-31T23:59:59Z' }, { now: Date.parse('0099-06-01T00:00:00Z') }).eligible, true);
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
  assert.equal(isCampaignCountryAllowed(['ZZ'], 'ZZ'), false);
  assert.equal(isCampaignCountryAllowed(['GE', 'ZZ'], 'GE'), true);
  assert.equal(isCampaignCountryAllowed([' ge '], 'GE'), true);
  assert.equal(isCampaignCountryAllowed([null, 7, ' zz ', ' us '], 'US'), true);
  assert.equal(isCampaignCountryAllowed(['ge'], 'ge'), false);
});

test('profile country normalization supports known aliases and fails closed for unknown labels', () => {
  assert.equal(resolveProfileCountryCode('Грузия'), 'GE');
  assert.equal(resolveProfileCountryCode('Georgia'), 'GE');
  assert.equal(resolveProfileCountryCode('GE'), 'GE');
  assert.equal(resolveProfileCountryCode('Türkiye'), 'TR');
  assert.equal(resolveProfileCountryCode('TÜRKİYE'), 'TR');
  assert.equal(resolveProfileCountryCode('Tu\u0308rkiye'), 'TR');
  assert.equal(resolveProfileCountryCode('  United   States  '), 'US');
  assert.equal(resolveProfileCountryCode('Unlisted country'), null);
  assert.equal(resolveProfileCountryCode(''), null);
});
