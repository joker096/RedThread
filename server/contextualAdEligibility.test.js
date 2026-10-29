import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON,
  BRIDAL_MIN_MATCH_AGE_DAYS,
  BRIDAL_MIN_MESSAGES_PER_PERSON,
  evaluateContextualAdEligibility
} from './contextualAdEligibility.js';

const campaign = {
  category: 'cafe',
  status: 'approved',
  active: true,
  startsAt: '2026-01-01T00:00:00Z',
  endsAt: '2027-01-01T00:00:00Z',
  now: Date.parse('2026-10-01T00:00:00Z'),
  regionAllowed: true,
  creativeApproved: true,
  advertiserVerified: true
};
const viewer = {
  accountEligible: true,
  adsConsent: true,
  dateOffersConsent: true,
  weddingOffersConsent: true,
  marriagePlanningOptIn: true,
  selfDescribedGender: 'woman',
  categoryConsents: { fashion: true, beauty: true, travel: true, general_local: true },
  legalOffersConsent: true,
  safetyRestricted: false
};
const confirmedMatch = {
  dateStatus: 'confirmed',
  mutuallyAcceptedDate: true,
  dateCancelled: false,
  partnerAdsConsent: true,
  partnerDateOffersConsent: true,
  regionAllowed: true,
  safetyRestricted: false,
  partnerAccountEligible: true,
  partnerSafetyRestricted: false,
  blocked: false,
  reported: false,
  paused: false
};
const bridalMatch = {
  ...confirmedMatch,
  ageDays: BRIDAL_MIN_MATCH_AGE_DAYS,
  viewerActiveDays: BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON,
  partnerActiveDays: BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON,
  viewerMessagesSent: BRIDAL_MIN_MESSAGES_PER_PERSON,
  partnerMessagesSent: BRIDAL_MIN_MESSAGES_PER_PERSON
};

function evaluate(overrides = {}) {
  return evaluateContextualAdEligibility({
    campaign: { ...campaign, ...overrides.campaign },
    viewer: { ...viewer, ...overrides.viewer },
    match: { ...confirmedMatch, ...overrides.match },
    surface: overrides.surface ?? 'confirmed_date_detail'
  });
}

test('fails closed when required context or campaign approval is missing', () => {
  assert.equal(evaluateContextualAdEligibility().reason, 'missing_context');
  assert.equal(evaluate({ campaign: { status: 'pending' } }).eligible, false);
  assert.equal(evaluate({ campaign: { startsAt: undefined } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { endsAt: undefined } }).reason, 'invalid_campaign_end');
  assert.equal(evaluate({ campaign: { advertiserVerified: false } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ campaign: { regionAllowed: false } }).reason, 'region_not_allowed');
  assert.equal(evaluate({ viewer: { adsConsent: false } }).reason, 'viewer_not_consented_or_eligible');
});

test('restaurant and cafe offers require an explicitly confirmed mutual date', () => {
  assert.deepEqual(evaluate(), { eligible: true, reason: 'confirmed_date' });
  assert.equal(evaluateContextualAdEligibility({ campaign, viewer, surface: 'confirmed_date_detail' }).reason, 'missing_context');
  assert.equal(evaluate({ match: { dateStatus: 'pending' } }).reason, 'date_not_mutually_confirmed');
  assert.equal(evaluate({ match: { mutuallyAcceptedDate: false } }).reason, 'date_not_mutually_confirmed');
  assert.equal(evaluate({ match: { dateCancelled: true } }).reason, 'date_cancelled');
  assert.equal(evaluate({ match: { dateCancelled: undefined } }).reason, 'date_cancellation_state_unknown');
  assert.equal(evaluate({ viewer: { dateOffersConsent: false } }).reason, 'date_offer_consent_required');
  assert.equal(evaluate({ match: { partnerAdsConsent: false } }).reason, 'both_participants_consent_required');
  assert.equal(evaluate({ match: { partnerDateOffersConsent: false } }).reason, 'both_participants_consent_required');
  assert.equal(evaluate({ match: { partnerAdsConsent: undefined } }).reason, 'both_participants_consent_required');
  assert.equal(evaluate({ surface: 'private_chat' }).reason, 'surface_excluded');
  assert.equal(evaluate({ surface: 'offers' }).reason, 'date_surface_required');
});

test('campaign registry categories gate contextual eligibility before specialized policy rules', () => {
  for (const category of ['bridal_dress', 'bridal_beauty', 'wedding_planner', 'wedding_photography', 'wedding_venue', 'legal', 'family_law']) {
    assert.equal(
      evaluateContextualAdEligibility({
        campaign: { ...campaign, category },
        viewer,
        match: bridalMatchForUnsupportedCategories(),
        surface: 'relationship_offers'
      }).reason,
      'campaign_category_not_allowed',
      category
    );
  }
});

function bridalMatchForUnsupportedCategories() {
  return {
    ...confirmedMatch,
    ageDays: BRIDAL_MIN_MATCH_AGE_DAYS,
    viewerActiveDays: BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON,
    partnerActiveDays: BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON,
    viewerMessagesSent: BRIDAL_MIN_MESSAGES_PER_PERSON,
    partnerMessagesSent: BRIDAL_MIN_MESSAGES_PER_PERSON
  };
}

test('user-requested gift discovery does not require a match or date', () => {
  const result = evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'flowers' },
    viewer,
    surface: 'user_requested_gift_discovery'
  });
  assert.deepEqual(result, { eligible: true, reason: 'user_requested_gift_discovery' });
  assert.equal(evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'cafe' }, viewer, surface: 'user_requested_gift_discovery'
  }).reason, 'missing_context');
  assert.equal(evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'gift' }, viewer: { ...viewer, safetyRestricted: undefined },
    surface: 'user_requested_gift_discovery'
  }).reason, 'safety_state_unavailable_or_restricted');
});

test('approved opt-in categories require their own consent and entry points, not a match', () => {
  assert.equal(evaluate({ campaign: { category: 'fashion' }, surface: 'offers' }).reason, 'category_opt_in');
  assert.equal(evaluate({ campaign: { category: 'fashion' }, viewer: { categoryConsents: {} }, surface: 'offers' }).reason, 'category_consent_required');

  const withoutMatch = (category, surface, viewerChanges = {}) => evaluateContextualAdEligibility({
    campaign: { ...campaign, category },
    viewer: { ...viewer, ...viewerChanges },
    surface
  });
  assert.deepEqual(withoutMatch('fashion', 'offers'), { eligible: true, reason: 'category_opt_in' });
  assert.deepEqual(withoutMatch('travel', 'relationship_offers'), { eligible: true, reason: 'category_opt_in' });
  assert.equal(withoutMatch('fashion', 'offers', { categoryConsents: {} }).reason, 'category_consent_required');
  assert.equal(withoutMatch('cafe', 'confirmed_date_detail').reason, 'missing_context');
  assert.equal(withoutMatch('family_law', 'user_requested_legal_help').reason, 'campaign_category_not_allowed');
  assert.equal(withoutMatch('bridal_dress', 'relationship_offers').reason, 'campaign_category_not_allowed');
});

test('safety states, blocked categories, unsupported categories and invalid dates deny delivery', () => {
  assert.equal(evaluate({ match: { blocked: true } }).reason, 'safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ match: { reported: true } }).reason, 'safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ viewer: { safetyRestricted: true } }).reason, 'safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ match: { paused: undefined } }).reason, 'safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ match: { partnerAccountEligible: undefined } }).reason, 'partner_safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ match: { partnerAccountEligible: false } }).reason, 'partner_safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ match: { partnerSafetyRestricted: true } }).reason, 'partner_safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ match: { partnerSafetyRestricted: undefined } }).reason, 'partner_safety_state_unavailable_or_restricted');
  assert.equal(evaluate({ campaign: { category: 'gambling' } }).reason, 'campaign_category_not_allowed');
  assert.equal(evaluate({ campaign: { category: 'unknown_kind' } }).reason, 'category_not_supported');
  assert.equal(evaluate({ campaign: { startsAt: 'not-a-date' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { startsAt: '1' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { startsAt: '2026-02-31T12:00:00Z' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { endsAt: '2026-10-01T12:00:00+14:01' } }).reason, 'invalid_campaign_end');
  assert.equal(evaluate({ campaign: { endsAt: '2026-09-01T00:00:00Z' } }).reason, 'campaign_expired');
  assert.equal(evaluate({ campaign: { startsAt: '2026-11-01T00:00:00Z' } }).reason, 'campaign_not_started');
});
