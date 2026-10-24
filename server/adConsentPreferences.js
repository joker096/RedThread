export const AD_CONSENT_VERSION = 1;
export const AD_CONSENT_CATEGORIES = Object.freeze([
  'fashion',
  'beauty',
  'travel',
  'general_local'
]);

export const DEFAULT_AD_CONSENT_PREFERENCES = Object.freeze({
  adsConsent: false,
  dateOffersConsent: false,
  weddingOffersConsent: false,
  marriagePlanningOptIn: false,
  categoryConsents: Object.freeze({})
});

export function normalizeAdConsentPreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_preferences' };
  }

  const allowedFields = new Set([
    'adsConsent',
    'dateOffersConsent',
    'weddingOffersConsent',
    'marriagePlanningOptIn',
    'categoryConsents'
  ]);
  if (Object.keys(input).some(key => !allowedFields.has(key))) {
    return { ok: false, error: 'unknown_preference_field' };
  }

  for (const key of ['adsConsent', 'dateOffersConsent', 'weddingOffersConsent', 'marriagePlanningOptIn']) {
    if (typeof input[key] !== 'boolean') {
      return { ok: false, error: 'boolean_preference_required', field: key };
    }
  }

  if (!input.categoryConsents || typeof input.categoryConsents !== 'object' ||
      Array.isArray(input.categoryConsents)) {
    return { ok: false, error: 'invalid_category_consents' };
  }

  const categoryConsents = {};
  for (const [category, enabled] of Object.entries(input.categoryConsents)) {
    if (!AD_CONSENT_CATEGORIES.includes(category)) {
      return { ok: false, error: 'unsupported_ad_category', category };
    }
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'boolean_category_consent_required', category };
    }
    if (enabled) categoryConsents[category] = true;
  }

  // Revoking the master consent atomically clears every dependent opt-in.
  if (input.adsConsent === false) {
    return {
      ok: true,
      value: {
        adsConsent: false,
        dateOffersConsent: false,
        weddingOffersConsent: false,
        marriagePlanningOptIn: false,
        categoryConsents: {}
      }
    };
  }

  if (input.marriagePlanningOptIn && !input.weddingOffersConsent) {
    return { ok: false, error: 'wedding_consent_required' };
  }

  return {
    ok: true,
    value: {
      adsConsent: true,
      dateOffersConsent: input.dateOffersConsent,
      weddingOffersConsent: input.weddingOffersConsent,
      marriagePlanningOptIn: input.marriagePlanningOptIn,
      categoryConsents
    }
  };
}

export function serializeAdConsentPreferences(row) {
  if (!row || row.ads_consent !== true) {
    return { ...DEFAULT_AD_CONSENT_PREFERENCES, categoryConsents: {} };
  }

  const weddingOffersConsent = row.wedding_offers_consent === true;
  const rawCategoryConsents = row.category_consents && typeof row.category_consents === 'object' &&
    !Array.isArray(row.category_consents) ? row.category_consents : {};
  const categoryConsents = {};

  // Treat persisted data as untrusted too: corrupt/stale rows must never re-enable
  // unknown categories or preferences whose parent consent has been revoked.
  for (const category of AD_CONSENT_CATEGORIES) {
    if (rawCategoryConsents[category] === true) categoryConsents[category] = true;
  }

  return {
    adsConsent: true,
    dateOffersConsent: row.date_offers_consent === true,
    weddingOffersConsent,
    marriagePlanningOptIn: weddingOffersConsent && row.marriage_planning_opt_in === true,
    categoryConsents
  };
}
