import test from 'node:test';
import assert from 'node:assert/strict';
import { AD_CONSENT_CATEGORIES } from './adConsentPreferences.js';
import { ALLOWED_AD_CAMPAIGN_CATEGORIES } from './adCampaignRegistry.js';
import {
  DATE_CONTEXT_AD_CATEGORIES,
  OPT_IN_AD_CATEGORIES,
  evaluateContextualAdEligibility
} from './contextualAdEligibility.js';

const campaign = {
  id: 'cafe_autumn_01',
  creativeVersion: 'creative-v3',
  creativeContext: 'general',
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
  status: 'active',
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
test('context and opt-in category sets partition the campaign registry allowlist', () => {
  assert.deepEqual([...OPT_IN_AD_CATEGORIES], [...AD_CONSENT_CATEGORIES]);
  const partition = [...DATE_CONTEXT_AD_CATEGORIES, ...OPT_IN_AD_CATEGORIES];
  assert.equal(new Set(partition).size, partition.length, 'policy category groups must not overlap');
  assert.deepEqual([...partition].sort(), [...ALLOWED_AD_CAMPAIGN_CATEGORIES].sort());
});

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
  assert.equal(evaluate({ campaign: { status: 'unknown' } }).reason, 'campaign_status_invalid');
  assert.equal(evaluate({ campaign: { status: 'pending' } }).reason, 'campaign_not_approved');
  assert.equal(evaluate({ campaign: { status: 'paused' } }).reason, 'campaign_not_approved');
  assert.equal(evaluate({ campaign: { status: 'rejected' } }).reason, 'campaign_not_approved');
  assert.equal(evaluate({ campaign: { status: undefined } }).reason, 'campaign_status_invalid');
  assert.equal(evaluate({ campaign: { status: 'expired' } }).reason, 'campaign_expired');
  assert.equal(evaluate({ campaign: { active: false } }).reason, 'campaign_not_active');
  assert.equal(evaluate({ campaign: { active: undefined } }).reason, 'campaign_not_active');
  assert.equal(evaluate({ campaign: { startsAt: undefined } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { endsAt: undefined } }).reason, 'invalid_campaign_end');
  assert.equal(evaluate({ campaign: { advertiserVerified: false } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ campaign: { creativeVersion: '' } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ campaign: { creativeVersion: undefined } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ campaign: { id: '' } }).reason, 'campaign_unknown');
  assert.equal(evaluate({ campaign: { id: undefined } }).reason, 'campaign_unknown');
  assert.equal(evaluate({ campaign: { id: '   ' } }).reason, 'campaign_unknown');
  assert.equal(evaluate({ campaign: { id: '\t\n' } }).reason, 'campaign_unknown');
  assert.equal(evaluate({ campaign: { now: Number.NaN } }).reason, 'invalid_validation_clock');
  assert.equal(evaluate({ campaign: { now: Infinity } }).reason, 'invalid_validation_clock');
  assert.equal(evaluate({ campaign: { regionAllowed: false } }).reason, 'region_not_allowed');
  assert.equal(evaluate({ campaign: { regionAllowed: undefined } }).reason, 'region_not_allowed');
  assert.equal(evaluate({ campaign: { creativeApproved: undefined } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ campaign: { advertiserVerified: undefined } }).reason, 'advertiser_or_creative_not_approved');
  assert.equal(evaluate({ viewer: { adsConsent: false } }).reason, 'viewer_not_consented_or_eligible');
  assert.equal(evaluate({ viewer: { adsConsent: undefined } }).reason, 'viewer_not_consented_or_eligible');
  assert.equal(evaluate({ viewer: { accountEligible: false } }).reason, 'viewer_not_consented_or_eligible');
  assert.equal(evaluate({ viewer: { accountEligible: undefined } }).reason, 'viewer_not_consented_or_eligible');
});

test('restaurant and cafe offers require an explicitly confirmed mutual date', () => {
  assert.deepEqual(evaluate(), { eligible: true, reason: 'confirmed_date' });
  assert.equal(evaluateContextualAdEligibility({ campaign, viewer, surface: 'confirmed_date_detail' }).reason, 'missing_context');
  assert.equal(evaluate({ match: { status: 'closed' } }).reason, 'match_not_active');
  assert.equal(evaluate({ match: { status: undefined } }).reason, 'match_not_active');
  assert.equal(evaluate({ match: { status: 'active', dateStatus: 'pending' } }).reason, 'date_not_mutually_confirmed');
  assert.equal(evaluate({ match: { mutuallyAcceptedDate: false } }).reason, 'date_not_mutually_confirmed');
  assert.equal(evaluate({ match: { dateCancelled: true } }).reason, 'date_cancelled');
  assert.equal(evaluate({ match: { dateCancelled: undefined } }).reason, 'date_cancellation_state_unknown');
  assert.equal(evaluate({ viewer: { dateOffersConsent: false } }).reason, 'date_offer_consent_required');
  assert.equal(evaluate({ viewer: { dateOffersConsent: undefined } }).reason, 'date_offer_consent_required');
  assert.equal(evaluate({ match: { partnerAdsConsent: false } }).reason, 'both_participants_consent_required');
  assert.equal(evaluate({ match: { partnerDateOffersConsent: false } }).reason, 'both_participants_consent_required');
  assert.equal(evaluate({ match: { regionAllowed: false } }).reason, 'match_region_not_allowed');
  assert.equal(evaluate({ match: { regionAllowed: undefined } }).reason, 'match_region_not_allowed');
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
        surface: 'relationship_offers'
      }).reason,
      'campaign_category_not_allowed',
      category
    );
  }
});

test('private and safety-critical surfaces reject every contextual ad category', () => {
  const excludedSurfaces = [
    'discovery', 'private_chat', 'voice_call', 'video_call',
    'verification', 'reporting', 'blocking', 'checkout', 'payment'
  ];
  const categories = [...DATE_CONTEXT_AD_CATEGORIES, ...OPT_IN_AD_CATEGORIES];

  for (const category of categories) {
    for (const surface of excludedSurfaces) {
      const result = evaluateContextualAdEligibility({
        campaign: { ...campaign, category },
        viewer,
        match: confirmedMatch,
        surface
      });
      assert.equal(result.eligible, false, `${category} must be denied on ${surface}`);
      assert.equal(result.reason, 'surface_excluded', `${category} on ${surface}`);
    }
  }
});

test('user-requested gift discovery does not require a match or date', () => {
  const result = evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'flowers' },
    viewer,
    surface: 'user_requested_gift_discovery'
  });
  assert.deepEqual(result, { eligible: true, reason: 'user_requested_gift_discovery' });
  assert.equal(evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'flowers', regionAllowed: false },
    viewer,
    surface: 'user_requested_gift_discovery'
  }).reason, 'region_not_allowed', 'user-requested gift discovery must not bypass campaign geography');
  assert.equal(evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'cafe' }, viewer, surface: 'user_requested_gift_discovery'
  }).reason, 'missing_context');
  assert.equal(evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'gift' }, viewer: { ...viewer, safetyRestricted: undefined },
    surface: 'user_requested_gift_discovery'
  }).reason, 'safety_state_unavailable_or_restricted');
  assert.equal(evaluateContextualAdEligibility({
    campaign: { ...campaign, category: 'flowers', creativeContext: 'bridal' }, viewer,
    surface: 'user_requested_gift_discovery'
  }).reason, 'bridal_category_not_supported', 'bridal creative must not bypass bridal relationship eligibility through gift discovery');
});

test('bridal creatives require explicit classification, opted-in adult women, and the full relationship threshold', () => {
  const bridalCampaign = { ...campaign, category: 'fashion', creativeContext: 'bridal' };
  const eligibleViewer = {
    ...viewer, selfDescribedGender: 'woman', age: 28,
    weddingOffersConsent: true, marriagePlanningOptIn: true
  };
  const eligibleMatch = {
    ...confirmedMatch,
    createdAt: '2026-09-01T00:00:00Z',
    activeDays: 3,
    viewerMessageCount: 20,
    partnerMessageCount: 20,
    partnerAdsConsent: true
  };
  const evaluateBridal = (campaignChanges = {}, viewerChanges = {}, matchChanges = {}, surface = 'relationship_offers') =>
    evaluateContextualAdEligibility({
      campaign: { ...bridalCampaign, ...campaignChanges },
      viewer: { ...eligibleViewer, ...viewerChanges },
      match: { ...eligibleMatch, ...matchChanges },
      surface
    });

  assert.deepEqual(evaluateBridal(), { eligible: true, reason: 'bridal_relationship' });
  assert.equal(evaluateBridal({ creativeContext: undefined }).reason, 'creative_context_unclassified');
  assert.equal(evaluateBridal({ creativeContext: 'general' }, { categoryConsents: { fashion: true } }).reason, 'category_opt_in');
  assert.equal(evaluateBridal({}, { selfDescribedGender: 'man' }).reason, 'bridal_audience_not_eligible');
  assert.equal(evaluateBridal({}, { age: 17 }).reason, 'bridal_audience_not_eligible');
  assert.equal(evaluateBridal({}, { age: undefined }).reason, 'bridal_audience_not_eligible');
  assert.equal(evaluateBridal({}, { weddingOffersConsent: false }).reason, 'bridal_consent_required');
  assert.equal(evaluateBridal({}, { marriagePlanningOptIn: false }).reason, 'bridal_consent_required');
  assert.equal(evaluateBridal({}, {}, { status: 'closed' }).reason, 'match_not_active');
  assert.equal(evaluateBridal({}, {}, { status: undefined }).reason, 'match_not_active');
  assert.equal(evaluateBridal({}, {}, { status: 'active', createdAt: 'invalid' }).reason, 'bridal_match_age_unavailable');
  assert.equal(evaluateBridal({}, {}, { createdAt: '2026-10-01T00:00:00Z' }).reason, 'bridal_match_too_new');
  assert.equal(evaluateBridal({}, {}, { activeDays: 2 }).reason, 'bridal_activity_insufficient');
  assert.equal(evaluateBridal({}, {}, { viewerMessageCount: 19 }).reason, 'bridal_conversation_insufficient');
  assert.equal(evaluateBridal({}, {}, { partnerMessageCount: 19 }).reason, 'bridal_conversation_insufficient');
  assert.equal(evaluateBridal({}, {}, { partnerAdsConsent: false }).reason, 'both_participants_consent_required');
  assert.equal(evaluateBridal({}, {}, { blocked: true }).reason, 'safety_state_unavailable_or_restricted');
  assert.equal(evaluateBridal({}, {}, { partnerSafetyRestricted: true }).reason, 'partner_safety_state_unavailable_or_restricted');
  assert.equal(evaluateBridal({}, {}, {}, 'offers').reason, 'bridal_surface_required');
  assert.equal(evaluateBridal({ category: 'travel' }).reason, 'bridal_category_not_supported');
});

test('approved opt-in categories require their own consent and entry points, not a match', () => {
  assert.equal(evaluate({ campaign: { category: 'fashion' }, surface: 'offers' }).reason, 'category_opt_in');
  assert.equal(evaluate({ campaign: { category: 'fashion', regionAllowed: false }, surface: 'offers' }).reason, 'region_not_allowed',
    'category-opt-in offers must still obey campaign geography');
  assert.equal(evaluate({ campaign: { category: 'fashion' }, viewer: { categoryConsents: {} }, surface: 'offers' }).reason, 'category_consent_required');
  assert.equal(evaluate({ campaign: { category: 'fashion' }, viewer: { categoryConsents: undefined }, surface: 'offers' }).reason, 'category_consent_required');

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
  assert.equal(evaluate({ campaign: { category: 'unknown_kind' } }).reason, 'campaign_category_not_allowed');
  assert.equal(evaluate({ campaign: { startsAt: 'not-a-date' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { startsAt: '1' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { startsAt: '2026-02-31T12:00:00Z' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { endsAt: '2026-10-01T12:00:00+14:01' } }).reason, 'invalid_campaign_end');
  assert.equal(evaluate({ campaign: { startsAt: '2026-10-01T00:00:00+14:00', endsAt: '2026-10-02T00:00:00+14:00', now: Date.parse('2026-10-01T00:00:00+14:00') } }).eligible, true);
  assert.equal(evaluate({ campaign: { startsAt: '2026-10-01T00:00:00+15:00' } }).reason, 'invalid_campaign_start');
  assert.equal(evaluate({ campaign: { startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' } }).reason, 'campaign_window_invalid');
  assert.equal(evaluate({ campaign: { startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' } }).reason, 'campaign_window_invalid');
  assert.equal(evaluate({ campaign: { endsAt: '2026-09-01T00:00:00Z' } }).reason, 'campaign_expired');
  assert.equal(evaluate({ campaign: { startsAt: '2026-11-01T00:00:00Z' } }).reason, 'campaign_not_started');
  assert.equal(evaluate({ campaign: { startsAt: '0099-01-01T00:00:00Z', endsAt: '0099-12-31T23:59:59Z', now: Date.parse('0099-06-01T00:00:00Z') } }).eligible, true);
});
