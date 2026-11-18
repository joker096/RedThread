import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AD_CONSENT_CATEGORIES,
  AD_CONSENT_VERSION,
  getAdConsentLifecycleGeneration,
  hasAdConsentRevocation,
  isSameAdConsentLifecycle,
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


test('consent category allowlists match both database snapshot validators', () => {
  for (const migrationName of [
    '044_ad_consent_history_snapshot_validation.sql',
    '046_ad_consent_canonical_category_values.sql'
  ]) {
    const migration = readFileSync(new URL(`./migrations/${migrationName}`, import.meta.url), 'utf8');
    const declaration = migration.match(/allowed_categories CONSTANT TEXT\[\] := ARRAY\[([^\]]+)\]/);
    assert.ok(declaration, `${migrationName} must define allowed consent categories`);
    const databaseCategories = [...declaration[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
    assert.deepEqual(databaseCategories, [...AD_CONSENT_CATEGORIES], migrationName);
  }
});

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

test('master consent revocation overrides malformed or missing dependent booleans', () => {
  for (const input of [
    { adsConsent: false, dateOffersConsent: 'yes', weddingOffersConsent: true, marriagePlanningOptIn: true, categoryConsents: {} },
    { adsConsent: false, dateOffersConsent: true, weddingOffersConsent: null, marriagePlanningOptIn: true, categoryConsents: {} },
    { adsConsent: false, categoryConsents: {} }
  ]) {
    assert.deepEqual(normalizeAdConsentPreferences(input), {
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

test('master consent revocation overrides unknown future fields', () => {
  assert.deepEqual(normalizeAdConsentPreferences({
    adsConsent: false,
    dateOffersConsent: true,
    weddingOffersConsent: true,
    marriagePlanningOptIn: true,
    categoryConsents: { travel: true },
    futurePreference: 'unknown'
  }), {
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


test('revocation detection covers master, dependent, and category consent withdrawals', () => {
  const previous = {
    ads_consent: true,
    date_offers_consent: true,
    wedding_offers_consent: true,
    marriage_planning_opt_in: true,
    category_consents: { fashion: true, travel: true }
  };
  assert.equal(hasAdConsentRevocation(previous, {
    adsConsent: true, dateOffersConsent: false, weddingOffersConsent: true,
    marriagePlanningOptIn: true, categoryConsents: { fashion: true, travel: true }
  }), true);
  assert.equal(hasAdConsentRevocation(previous, {
    adsConsent: true, dateOffersConsent: true, weddingOffersConsent: true,
    marriagePlanningOptIn: true, categoryConsents: { fashion: true }
  }), true);
  assert.equal(hasAdConsentRevocation(previous, {
    adsConsent: true, dateOffersConsent: true, weddingOffersConsent: true,
    marriagePlanningOptIn: true, categoryConsents: { fashion: true, travel: true }
  }), false);
  assert.equal(hasAdConsentRevocation(null, {
    adsConsent: false, dateOffersConsent: false, weddingOffersConsent: false,
    marriagePlanningOptIn: false, categoryConsents: {}
  }), false);
});

test('ad-consent lifecycle generation is stable and changes on re-consent', () => {
  const first = {
    consent_version: 1,
    updated_at: '2026-11-18T08:00:00.000Z',
    ads_consent: true,
    date_offers_consent: true,
    wedding_offers_consent: false,
    marriage_planning_opt_in: false,
    category_consents: { travel: true }
  };
  assert.equal(getAdConsentLifecycleGeneration(first), '1:2026-11-18T08:00:00.000Z');
  assert.notEqual(getAdConsentLifecycleGeneration({ ...first, updated_at: '2026-11-18 08:00:00.000123+00' }), getAdConsentLifecycleGeneration({ ...first, updated_at: '2026-11-18 08:00:00.000456+00' }));
  assert.equal(isSameAdConsentLifecycle(first, { ...first, updated_at: '2026-11-18T08:00:00.000Z' }), true);
  assert.equal(isSameAdConsentLifecycle({ ...first, category_consents: { travel: true, fashion: true } }, { ...first, category_consents: { fashion: true, travel: true } }), true);
  assert.equal(isSameAdConsentLifecycle(first, { ...first, updated_at: '2026-11-18T08:01:00.000Z' }), false);
  assert.equal(isSameAdConsentLifecycle(first, { ...first, category_consents: {} }), false);
  assert.throws(() => getAdConsentLifecycleGeneration({ consent_version: 0, updated_at: first.updated_at }), /ad_consent_lifecycle_generation_invalid/);
});


test('ad consent route cannot apply a revocation before Ledger ACK or reuse a stale lifecycle', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.put('/api/ads/consent'");
  const end = source.indexOf("app.post('/api/ads/events'", start);
  assert.ok(start >= 0 && end > start, 'ad consent route boundaries must exist');
  const route = source.slice(start, end);
  const preflight = route.indexOf('const preflight = await pool.query');
  const coordinator = route.indexOf('runAckGatedPrivacyRecoveryOperation({');
  const mutation = route.indexOf('persistPreferencesAndHistory(transactionClient)');
  assert.ok(preflight >= 0 && coordinator > preflight && mutation > coordinator);
  assert.equal(route.includes('enqueuePrivacyRecoveryEvent'), false, 'ad revocation must not use the legacy outbox path');
  assert.ok(route.includes('isSameAdConsentLifecycle(previous, current)'), 'the exact preflight lifecycle must be revalidated after ACK');
  assert.ok(route.includes("throw new Error('ad_consent_state_changed_retry')"));
  assert.ok(route.includes('updated_at::text AS updated_at'), 'PostgreSQL timestamp precision must be retained');
});


test('ad-consent revocation persists no database lock across Ledger ACK and revalidates the exact grant', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.put('/api/ads/consent'");
  const end = source.indexOf("app.post('/api/ads/events'", start);
  assert.ok(start >= 0 && end > start, 'ad-consent route boundaries must exist');
  const route = source.slice(start, end);
  const preflight = route.indexOf('const preflight = await pool.query');
  const ack = route.indexOf('runAckGatedPrivacyRecoveryOperation({');
  const callback = route.indexOf('apply: async transactionClient =>');
  const lifecycleCheck = route.indexOf('isSameAdConsentLifecycle(previous, current)');
  const applyCall = route.indexOf('return persistPreferencesAndHistory(transactionClient);');
  assert.ok(preflight >= 0 && ack > preflight && callback > ack && lifecycleCheck > callback,
    'revocation must capture a lock-free snapshot, obtain ACK, then revalidate the same lifecycle');
  assert.ok(applyCall > lifecycleCheck,
    'the preference/history persistence callback must run only after lifecycle revalidation');
  assert.ok(route.includes('getAdConsentLifecycleGeneration(previous)'));
  assert.ok(route.includes('ad_consent_state_changed_retry'));
  assert.equal(route.includes('enqueuePrivacyRecoveryEvent'), false);
});
