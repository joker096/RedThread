export function normalizeGiftReceivingPreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_gift_preferences' };
  }
  const keys = Object.keys(input);
  if (keys.some(key => key !== 'requestsEnabled') || typeof input.requestsEnabled !== 'boolean') {
    return { ok: false, error: 'invalid_gift_preferences', field: 'requestsEnabled' };
  }
  return { ok: true, value: { requestsEnabled: input.requestsEnabled } };
}

export function serializeGiftReceivingPreferences(row) {
  return { requestsEnabled: row?.requests_enabled === true };
}
