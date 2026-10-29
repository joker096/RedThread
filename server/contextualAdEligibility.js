import { ALLOWED_AD_CAMPAIGN_CATEGORIES } from './adCampaignRegistry.js';

// Keep this gate aligned with server/adCampaignRegistry.js and migration 039.
// Context rules must not authorize categories that the campaign registry rejects.
export const DATE_CONTEXT_AD_CATEGORIES = Object.freeze([
  'restaurant', 'cafe', 'date_experience', 'flowers', 'gift'
]);
export const OPT_IN_AD_CATEGORIES = Object.freeze([
  'fashion', 'beauty', 'travel', 'general_local'
]);

const APPROVED_CAMPAIGN_CATEGORIES = new Set(ALLOWED_AD_CAMPAIGN_CATEGORIES);
const DATE_CONTEXT_CATEGORIES = new Set(DATE_CONTEXT_AD_CATEGORIES);
const OPT_IN_CATEGORIES = new Set(OPT_IN_AD_CATEGORIES);

const isNonNegativeInteger = value => Number.isInteger(value) && value >= 0;

/**
 * Pure, fail-closed eligibility decision for contextual offers.
 *
 * This helper is not an ad-serving endpoint and must be called with trusted,
 * server-loaded consent, match, safety and campaign data. Never pass client
 * assertions as authoritative eligibility facts.
 */
export function evaluateContextualAdEligibility({ campaign, viewer, match, surface } = {}) {
  if (!campaign || !viewer || typeof surface !== 'string') {
    return deny('missing_context');
  }

  const category = campaign.category;
  if (typeof category !== 'string' || !/^[a-z][a-z0-9_]{1,47}$/.test(category)) {
    return deny('invalid_category');
  }
  if (!APPROVED_CAMPAIGN_CATEGORIES.has(category)) return deny('campaign_category_not_allowed');
  if (typeof campaign.id !== 'string' || campaign.id.trim().length === 0) return deny('campaign_unknown');
  if (campaign.status !== 'approved') return deny(campaign.status === 'expired' ? 'campaign_expired' : 'campaign_not_approved');
  if (campaign.active !== true) return deny('campaign_not_active');
  if (!isValidDate(campaign.startsAt)) return deny('invalid_campaign_start');
  if (!isValidDate(campaign.endsAt)) return deny('invalid_campaign_end');
  const startsAt = Date.parse(campaign.startsAt);
  const endsAt = Date.parse(campaign.endsAt);
  if (endsAt <= startsAt) return deny('campaign_window_invalid');
  if (campaign.now !== undefined && !Number.isFinite(campaign.now)) return deny('invalid_validation_clock');
  const now = campaign.now === undefined ? Date.now() : campaign.now;
  if (campaign.startsAt && Date.parse(campaign.startsAt) > now) return deny('campaign_not_started');
  if (campaign.endsAt && Date.parse(campaign.endsAt) <= now) return deny('campaign_expired');
  if (campaign.regionAllowed !== true) return deny('region_not_allowed');
  if (campaign.creativeApproved !== true || campaign.advertiserVerified !== true ||
      typeof campaign.creativeVersion !== 'string' || !campaign.creativeVersion.trim()) {
    return deny('advertiser_or_creative_not_approved');
  }
  if (viewer.accountEligible !== true || viewer.adsConsent !== true) return deny('viewer_not_consented_or_eligible');
  // Safety state must be explicitly loaded from trusted server records; unknown is not equivalent to safe.
  if (viewer.safetyRestricted !== false) return deny('safety_state_unavailable_or_restricted');
  const userRequestedGiftDiscovery = surface === 'user_requested_gift_discovery'
    && (category === 'flowers' || category === 'gift');
  // A user-opened gift catalog is independent of a match/date and does not
  // reveal anything about another person. Explicit navigation is the opt-in.
  if (userRequestedGiftDiscovery) return allow('user_requested_gift_discovery');

  // Private or safety-critical surfaces never carry advertising.
  if (['discovery', 'private_chat', 'voice_call', 'video_call', 'verification', 'reporting', 'blocking', 'checkout', 'payment'].includes(surface)) {
    return deny('surface_excluded');
  }

  if (DATE_CONTEXT_CATEGORIES.has(category)) {
    if (!match) return deny('missing_context');
    if (match.safetyRestricted !== false || match.blocked !== false
      || match.reported !== false || match.paused !== false) {
      return deny('safety_state_unavailable_or_restricted');
    }
    if (match.partnerAccountEligible !== true || match.partnerSafetyRestricted !== false) {
      return deny('partner_safety_state_unavailable_or_restricted');
    }
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

  if (OPT_IN_CATEGORIES.has(category)) {
    if (surface !== 'offers' && surface !== 'relationship_offers') return deny('offers_surface_required');
    if (viewer.categoryConsents?.[category] !== true) return deny('category_consent_required');
    return allow('category_opt_in');
  }

  // Unknown categories are never implicitly eligible.
  return deny('category_not_supported');
}

function isValidDate(value) {
  if (typeof value !== 'string') return false;
  // Campaign windows must be explicit ISO timestamps; Date.parse accepts ambiguous values such as "1".
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // setUTCFullYear avoids Date.UTC's special treatment of years 0–99 as 1900–1999.
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const offset = match[8];
  if (offset.toUpperCase() !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return true;
}

function allow(reason) {
  return { eligible: true, reason };
}

function deny(reason) {
  return { eligible: false, reason };
}
