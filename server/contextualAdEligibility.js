export const BRIDAL_MIN_MATCH_AGE_DAYS = 14;
export const BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON = 3;
export const BRIDAL_MIN_MESSAGES_PER_PERSON = 20;

const DATE_CONTEXT_CATEGORIES = new Set(['restaurant', 'cafe', 'date_experience', 'flowers', 'gift']);
const OPT_IN_CATEGORIES = new Set(['fashion', 'beauty', 'travel', 'general_local']);
const BRIDAL_CATEGORIES = new Set(['bridal_dress', 'bridal_beauty', 'wedding_planner', 'wedding_photography', 'wedding_venue']);
const LEGAL_CATEGORIES = new Set(['legal', 'family_law']);
const FORBIDDEN_CATEGORIES = new Set(['gambling', 'tobacco', 'adult_services', 'political', 'religious', 'unreviewed_health', 'unreviewed_finance']);

const isNonNegativeInteger = value => Number.isInteger(value) && value >= 0;

/**
 * Pure, fail-closed eligibility decision for contextual offers.
 *
 * This helper is not an ad-serving endpoint and must be called with trusted,
 * server-loaded consent, match, safety and campaign data. Never pass client
 * assertions as authoritative eligibility facts.
 */
export function evaluateContextualAdEligibility({ campaign, viewer, match, surface } = {}) {
  if (!campaign || !viewer || !match || typeof surface !== 'string') {
    return deny('missing_context');
  }

  const category = campaign.category;
  if (typeof category !== 'string' || !/^[a-z][a-z0-9_]{1,47}$/.test(category)) {
    return deny('invalid_category');
  }
  if (campaign.status !== 'approved' || campaign.active !== true) return deny('campaign_not_active');
  if (!isValidDate(campaign.startsAt)) return deny('invalid_campaign_start');
  if (!isValidDate(campaign.endsAt)) return deny('invalid_campaign_end');
  const now = Number.isFinite(campaign.now) ? campaign.now : Date.now();
  if (campaign.startsAt && Date.parse(campaign.startsAt) > now) return deny('campaign_not_started');
  if (campaign.endsAt && Date.parse(campaign.endsAt) <= now) return deny('campaign_expired');
  if (campaign.regionAllowed !== true) return deny('region_not_allowed');
  if (campaign.creativeApproved !== true || campaign.advertiserVerified !== true) {
    return deny('advertiser_or_creative_not_approved');
  }
  if (FORBIDDEN_CATEGORIES.has(category)) return deny('category_blocked');
  if (viewer.accountEligible !== true || viewer.adsConsent !== true) return deny('viewer_not_consented_or_eligible');
  // Safety state must be explicitly loaded from trusted server records; unknown is not equivalent to safe.
  if (viewer.safetyRestricted !== false || match.safetyRestricted !== false || match.partnerSafetyRestricted !== false
    || match.partnerAccountEligible !== true || match.blocked !== false || match.reported !== false || match.paused !== false) {
    return deny('safety_state_unavailable_or_restricted');
  }

  // Private or safety-critical surfaces never carry advertising.
  if (['discovery', 'private_chat', 'voice_call', 'video_call', 'verification', 'reporting', 'blocking', 'checkout', 'payment'].includes(surface)) {
    return deny('surface_excluded');
  }

  if (DATE_CONTEXT_CATEGORIES.has(category)) {
    if (surface !== 'confirmed_date_detail') return deny('date_surface_required');
    if (match.dateStatus !== 'confirmed' || match.mutuallyAcceptedDate !== true) return deny('date_not_mutually_confirmed');
    if (match.dateCancelled !== false) return deny(match.dateCancelled === true ? 'date_cancelled' : 'date_cancellation_state_unknown');
    if (viewer.dateOffersConsent !== true) return deny('date_offer_consent_required');
    // Date-context offers are pair-contextual: both participants must independently opt in.
    if (match.partnerAdsConsent !== true || match.partnerDateOffersConsent !== true) {
      return deny('both_participants_consent_required');
    }
    if (match.regionAllowed !== true) return deny('match_region_not_allowed');
    return allow('confirmed_date');
  }

  if (BRIDAL_CATEGORIES.has(category)) {
    if (surface !== 'relationship_offers') return deny('relationship_offers_surface_required');
    if (viewer.selfDescribedGender !== 'woman') return deny('bridal_audience_ineligible');
    if (viewer.weddingOffersConsent !== true) return deny('wedding_consent_required');
    if (viewer.marriagePlanningOptIn !== true) return deny('marriage_planning_opt_in_required');
    if (!isNonNegativeInteger(match.ageDays) || match.ageDays < BRIDAL_MIN_MATCH_AGE_DAYS) return deny('match_too_new');
    if (!isNonNegativeInteger(match.viewerActiveDays) || !isNonNegativeInteger(match.partnerActiveDays)
      || match.viewerActiveDays < BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON
      || match.partnerActiveDays < BRIDAL_MIN_ACTIVE_DAYS_PER_PERSON) return deny('insufficient_mutual_activity');
    if (!isNonNegativeInteger(match.viewerMessagesSent) || !isNonNegativeInteger(match.partnerMessagesSent)
      || match.viewerMessagesSent < BRIDAL_MIN_MESSAGES_PER_PERSON
      || match.partnerMessagesSent < BRIDAL_MIN_MESSAGES_PER_PERSON) return deny('insufficient_mutual_conversation');
    if (match.regionAllowed !== true) return deny('match_region_not_allowed');
    return allow('bridal_opt_in_and_mutual_activity');
  }

  if (OPT_IN_CATEGORIES.has(category)) {
    if (surface !== 'offers' && surface !== 'relationship_offers') return deny('offers_surface_required');
    if (viewer.categoryConsents?.[category] !== true) return deny('category_consent_required');
    return allow('category_opt_in');
  }

  if (LEGAL_CATEGORIES.has(category)) {
    if (surface !== 'user_requested_legal_help') return deny('user_requested_legal_help_required');
    if (viewer.legalOffersConsent !== true) return deny('legal_consent_required');
    return allow('user_requested_legal_help');
  }

  // Unknown categories are never implicitly eligible.
  return deny('category_not_supported');
}

function isValidDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function allow(reason) {
  return { eligible: true, reason };
}

function deny(reason) {
  return { eligible: false, reason };
}
