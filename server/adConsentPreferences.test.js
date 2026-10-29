import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_CONSENT_VERSION,
  normalizeAdConsentPreferences,
  serializeAdConsentPreferences
} from './adConsentPreferences.js';

const valid = {
  adsConsent: true,
  dateOffersConsent: false,
  weddingOffersConsent: false,
  marriagePlanningOptIn: false,
  categoryConsents: {}
};

test('consent preferences require explicit booleans and known fields', () => {
  assert.equal(normalizeAdConsentPreferences(null).error, 'invalid_preferences');
  assert.equal(normalizeAdConsentPreferences({ ...valid, adsConsent: 'yes' }).error, 'boolean_preference_required');
  assert.equal(normalizeAdConsentPreferences({ ...valid, surprise: true }).error, 'unknown_preference_field');
  assert.equal(normalizeAdConsentPreferences({ ...valid, categoryConsents: ['travel'] }).error, 'invalid_category_consents');
  assert.equal(AD_CONSENT_VERSION, 1);
});

test('master consent revocation clears all dependent preferences atomically', () => {
  const result = normalizeAdConsentPreferences({
    adsConsent: false,
    dateOffersConsent: true,
    weddingOffersConsent: true,
    marriagePlanningOptIn: true,
    categoryConsents: { fashion: true, travel: true }
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      adsConsent: false,
      dateOffersConsent: false,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: {}
    }
  });
});

test('master consent revocation succeeds despite stale or malformed dependent category values', () => {
  for (const categoryConsents of [
    { political: true },
    { travel: 'true' },
    ['travel']
  ]) {
    const result = normalizeAdConsentPreferences({
      adsConsent: false,
      dateOffersConsent: true,
      weddingOffersConsent: true,
      marriagePlanningOptIn: true,
      categoryConsents
    });
    assert.deepEqual(result, {
      ok: true,
      value: {
        adsConsent: false,
        dateOffersConsent: false,
        weddingOffersConsent: false,
        marriagePlanningOptIn: false,
        categoryConsents: {}
      }
    });
  }
});

test('rejects marriage planning without wedding-offer consent', () => {
  assert.equal(normalizeAdConsentPreferences({
    ...valid,
    marriagePlanningOptIn: true
  }).error, 'wedding_consent_required');
});

test('only supported category keys and boolean values are accepted', () => {
  assert.equal(normalizeAdConsentPreferences({
    ...valid,
    categoryConsents: { political: true }
  }).error, 'unsupported_ad_category');
  assert.equal(normalizeAdConsentPreferences({
    ...valid,
    categoryConsents: { travel: 'true' }
  }).error, 'boolean_category_consent_required');
  assert.deepEqual(normalizeAdConsentPreferences({
    ...valid,
    categoryConsents: { travel: true, beauty: false }
  }).value.categoryConsents, { travel: true });
});

test('missing database preferences serialize as consent-off defaults', () => {
  assert.deepEqual(serializeAdConsentPreferences(null), {
    adsConsent: false,
    dateOffersConsent: false,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: {}
  });
});

test('database preferences are serialized to the public camelCase shape', () => {
  assert.deepEqual(serializeAdConsentPreferences({
    ads_consent: true,
    consent_version: AD_CONSENT_VERSION,
    date_offers_consent: true,
    wedding_offers_consent: false,
    marriage_planning_opt_in: false,
    category_consents: { fashion: true }
  }), {
    adsConsent: true,
    dateOffersConsent: true,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: { fashion: true }
  });
});

test('persisted inconsistent consent fails closed and strips unsupported categories', () => {
  assert.deepEqual(serializeAdConsentPreferences({
    ads_consent: false,
    date_offers_consent: true,
    wedding_offers_consent: true,
    marriage_planning_opt_in: true,
    category_consents: { fashion: true, political: true }
  }), {
    adsConsent: false,
    dateOffersConsent: false,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: {}
  });

  assert.deepEqual(serializeAdConsentPreferences({
    ads_consent: true,
    consent_version: AD_CONSENT_VERSION,
    date_offers_consent: true,
    wedding_offers_consent: false,
    marriage_planning_opt_in: true,
    category_consents: { travel: true, political: true, beauty: 'yes' }
  }), {
    adsConsent: true,
    dateOffersConsent: true,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: { travel: true }
  });
});


test('persisted consent from an older policy version fails closed', () => {
  assert.deepEqual(serializeAdConsentPreferences({
    ads_consent: true,
    consent_version: AD_CONSENT_VERSION - 1,
    date_offers_consent: true,
    wedding_offers_consent: true,
    marriage_planning_opt_in: true,
    category_consents: { fashion: true }
  }), {
    adsConsent: false,
    dateOffersConsent: false,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: {}
  });
});
