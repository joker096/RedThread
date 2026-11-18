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

  if (typeof input.adsConsent !== 'boolean') {
    return { ok: false, error: 'boolean_preference_required', field: 'adsConsent' };
  }

  // An explicit master opt-out must not be blocked by stale or malformed child
  // preferences. Clear all dependent choices before validating their values.
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

  for (const key of ['dateOffersConsent', 'weddingOffersConsent', 'marriagePlanningOptIn']) {
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
  // Consent given under an older policy version is not consent to newly introduced
  // purposes or terms. Require a fresh explicit choice after the version changes.
  if (!row || row.ads_consent !== true || row.consent_version !== AD_CONSENT_VERSION) {
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


/** True when any previously granted ad purpose is removed by the next choice. */
export function hasAdConsentRevocation(previous, next) {
  if (!previous || !next) return false;
  const previousCategories = previous.category_consents && typeof previous.category_consents === 'object' &&
    !Array.isArray(previous.category_consents) ? previous.category_consents : {};
  const categoryRevoked = Object.entries(previousCategories).some(([key, enabled]) =>
    enabled === true && next.categoryConsents?.[key] !== true
  );
  return Boolean(
    (previous.ads_consent === true && next.adsConsent !== true) ||
    (previous.date_offers_consent === true && next.dateOffersConsent !== true) ||
    (previous.wedding_offers_consent === true && next.weddingOffersConsent !== true) ||
    (previous.marriage_planning_opt_in === true && next.marriagePlanningOptIn !== true) ||
    categoryRevoked
  );
}

/** Stable generation for the exact stored consent row, not the HTTP attempt. */
export function getAdConsentLifecycleGeneration(previous) {
  if (!previous || !previous.updated_at) throw new TypeError('ad_consent_lifecycle_generation_invalid');
  const updatedAt = String(previous.updated_at);
  if (!Number.isFinite(new Date(updatedAt).getTime())) throw new TypeError('ad_consent_lifecycle_generation_invalid');
  const version = Number(previous.consent_version);
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('ad_consent_lifecycle_generation_invalid');
  // Preserve PostgreSQL timestamp precision; converting through JS Date would
  // truncate microseconds and could collapse two distinct consent generations.
  return `${version}:${updatedAt}`;
}

/** Compare the consent lifecycle snapshot captured before the remote Ledger call. */
export function isSameAdConsentLifecycle(previous, current) {
  if (!previous || !current) return previous == null && current == null;
  try {
    return getAdConsentLifecycleGeneration(previous) === getAdConsentLifecycleGeneration(current) &&
      previous.ads_consent === current.ads_consent &&
      previous.date_offers_consent === current.date_offers_consent &&
      previous.wedding_offers_consent === current.wedding_offers_consent &&
      previous.marriage_planning_opt_in === current.marriage_planning_opt_in &&
      JSON.stringify(previous.category_consents ?? {}) === JSON.stringify(current.category_consents ?? {});
  } catch {
    return false;
  }
}
