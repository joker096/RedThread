export const AD_IMPRESSION_CAP_24H = 3;

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
  return Array.isArray(rows) && rows[0]?.ads_consent === true;
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
 * Persisted engagement rows alone are not billing evidence. A billing pipeline
 * must supply separately verified campaign, viewability, invalid-traffic and
 * attribution evidence; missing or client-provided proof is never sufficient.
 */
export function evaluateAdEventBillingEligibility({ event, campaignApproved, viewabilityVerified, invalidTrafficChecked, attributionValid, proofSource } = {}) {
  if (!event || !['impression', 'click'].includes(event.event_type)) {
    return { billable: false, reason: 'invalid_event' };
  }
  if (campaignApproved !== true || viewabilityVerified !== true || invalidTrafficChecked !== true || attributionValid !== true) {
    return { billable: false, reason: 'billing_evidence_incomplete' };
  }
  if (proofSource !== 'trusted_server_measurement') {
    return { billable: false, reason: 'untrusted_billing_evidence' };
  }
  return { billable: true, reason: 'verified_billing_evidence' };
}
