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
