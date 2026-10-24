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
  regionAllowed: true,
  safetyRestricted: false,
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
  assert.equal(evaluate({ campaign: { advertiserVerified: false } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ campaign: { regionAllowed: false } }).reason, 'region_not_allowed');
  assert.equal(evaluate({ viewer: { adsConsent: false } }).reason, 'viewer_not_consented_or_eligible');
});

test('restaurant and cafe offers require an explicitly confirmed mutual date', () => {
  assert.deepEqual(evaluate(), { eligible: true, reason: 'confirmed_date' });
  assert.equal(evaluate({ match: { dateStatus: 'pending' } }).reason, 'date_not_mutually_confirmed');
  assert.equal(evaluate({ match: { mutuallyAcceptedDate: false } }).reason, 'date_not_mutually_confirmed');
  assert.equal(evaluate({ match: { dateCancelled: true } }).reason, 'date_cancelled');
  assert.equal(evaluate({ viewer: { dateOffersConsent: false } }).reason, 'date_offer_consent_required');
  assert.equal(evaluate({ surface: 'private_chat' }).reason, 'surface_excluded');
  assert.equal(evaluate({ surface: 'offers' }).reason, 'date_surface_required');
});

test('bridal offers are restricted to opted-in women with sustained mutual activity', () => {
  const result = evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'bridal_dress' },
    viewer,
    match: bridalMatch,
    surface: 'relationship_offers'
  });
  assert.deepEqual(result, { eligible: true, reason: 'bridal_opt_in_and_mutual_activity' });

  const check = (viewerChanges = {}, matchChanges = {}, surface = 'relationship_offers') =>
    evaluateContextualAdEligibility({
      campaign: { ...campaign, category: 'bridal_dress' },
      viewer: { ...viewer, ...viewerChanges },
      match: { ...bridalMatch, ...matchChanges },
      surface
    });

  assert.equal(check({ selfDescribedGender: 'man' }).reason, 'bridal_audience_ineligible');
  assert.equal(check({ weddingOffersConsent: false }).reason, 'wedding_consent_required');
  assert.equal(check({ marriagePlanningOptIn: false }).reason, 'marriage_planning_opt_in_required');
  assert.equal(check({}, { ageDays: BRIDAL_MIN_MATCH_AGE_DAYS - 1 }).reason, 'match_too_new');
  assert.equal(check({}, { viewerActiveDays: BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON - 1 }).reason, 'insufficient_mutual_activity');
  assert.equal(check({}, { partnerActiveDays: BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON - 1 }).reason, 'insufficient_mutual_activity');
  assert.equal(check({}, { viewerMessagesSent: BRIDAL_MIN_MESSAGES_PER_PERSON - 1 }).reason, 'insufficient_mutual_conversation');
  assert.equal(check({}, { partnerMessagesSent: BRIDAL_MIN_MESSAGES_PER_PERSON - 1 }).reason, 'insufficient_mutual_conversation');
  assert.equal(check({}, {}, 'private_chat').reason, 'surface_excluded');
});

test('opt-in categories and legal help require their own consent and entry points', () => {
  assert.equal(evaluate({ campaign: { category: 'fashion' }, surface: 'offers' }).reason, 'category_opt_in');
  assert.equal(evaluate({ campaign: { category: 'fashion' }, viewer: { categoryConsents: {} }, surface: 'offers' }).reason, 'category_consent_required');
  assert.equal(evaluate({ campaign: { category: 'family_law' }, surface: 'user_requested_legal_help' }).reason, 'user_requested_legal_help');
  assert.equal(evaluate({ campaign: { category: 'family_law' }, surface: 'offers' }).reason, 'user_requested_legal_help_required');
});

test('safety states, blocked categories, unsupported categories and invalid dates deny delivery', () => {
  assert.equal(evaluate({ match: { blocked: true } }).reason, 'safety_suppressed');
  assert.equal(evaluate({ match: { reported: true } }).reason, 'safety_suppressed');
  assert.equal(evaluate({ viewer: { safetyRestricted: true } }).reason, 'safety_suppressed');
  assert.equal(evaluate({ campaign: { category: 'gambling' } }).reason, 'category_blocked');
  assert.equal(evaluate({ campaign: { category: 'unknown_kind' } }).reason, 'category_not_supported');
  assert.equal(evaluate({ campaign: { startsAt: 'not-a-date' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { endsAt: '2026-09-01T00:00:00Z' } }).reason, 'campaign_expired');
  assert.equal(evaluate({ campaign: { startsAt: '2026-11-01T00:00:00Z' } }).reason, 'campaign_not_started');
});
