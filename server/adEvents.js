import { AD_CONSENT_VERSION } from './adConsentPreferences.js';

/**
 * Event ingestion is hard-disabled until a trusted server-side delivery path
 * can issue and validate placement receipts bound to contextual eligibility.
 * An environment flag must not bypass that security prerequisite.
 */
export function isAdEventCollectionEnabled() {
  return false;
}

export const AD_IMPRESSION_CAP_24H = 3;
// Separate cap prevents a single user from generating unlimited click events.
export const AD_CLICK_CAP_24H = 5;

export function validateAdEventPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_ad_event' };
  }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim().toLowerCase() : '';
  const campaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : '';
  const eventType = body.eventType;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)) {
    return { ok: false, error: 'invalid_event_id' };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(campaignId)) {
    return { ok: false, error: 'invalid_campaign_id' };
  }
  if (eventType !== 'impression' && eventType !== 'click') {
    return { ok: false, error: 'invalid_event_type' };
  }

  return { ok: true, value: { eventId, campaignId, eventType } };
}

/**
 * Ad engagement events are permitted only when a persisted, explicit opt-in exists.
 * Missing rows and every value other than boolean true fail closed.
 */
export function hasExplicitAdConsent(rows) {
  return Array.isArray(rows) && rows[0]?.ads_consent === true &&
    rows[0]?.consent_version === AD_CONSENT_VERSION;
}

/**
 * Idempotency keys are scoped to the exact authenticated event payload.
 * A reused UUID with different ownership or content must not be treated as a successful retry.
 */
export function classifyDuplicateAdEvent(row, { userId, campaignId, eventType }) {
  if (!row) return 'new';
  if (
    String(row.user_id) === String(userId) &&
    row.campaign_id === campaignId &&
    row.event_type === eventType
  ) {
    return 'duplicate';
  }
  return 'conflict';
}

/**
 * No trusted measurement verifier or billing pipeline is implemented yet.
 * Caller-supplied booleans and a string label are not proof of verification,
 * so no event can become billable through this helper alone.
 */
export function evaluateAdEventBillingEligibility(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { billable: false, reason: 'invalid_event' };
  }
  const { event } = input;
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !['impression', 'click'].includes(event.event_type)) {
    return { billable: false, reason: 'invalid_event' };
  }
  return { billable: false, reason: 'billing_pipeline_unavailable' };
}

/**
 * Pure frequency decision shared by the endpoint and unit tests.
 * Counts must come from trusted persisted rows, never request payloads.
 */
export function evaluateAdEventFrequency(input = {}) {
  const { eventType, impressionCount, clickCount } =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (eventType !== 'impression' && eventType !== 'click') {
    return { allowed: false, reason: 'invalid_event_type' };
  }
  if (!Number.isSafeInteger(impressionCount) || impressionCount < 0 ||
      !Number.isSafeInteger(clickCount) || clickCount < 0) {
    return { allowed: false, reason: 'invalid_event_counts' };
  }
  if (eventType === 'impression' && impressionCount >= AD_IMPRESSION_CAP_24H) {
    return { allowed: false, reason: 'ad_frequency_cap_reached' };
  }
  if (eventType === 'click' && clickCount >= AD_CLICK_CAP_24H) {
    return { allowed: false, reason: 'ad_click_frequency_cap_reached' };
  }
  if (eventType === 'click' && impressionCount < 1) {
    return { allowed: false, reason: 'impression_required_before_click' };
  }
  return { allowed: true, reason: null };
}
