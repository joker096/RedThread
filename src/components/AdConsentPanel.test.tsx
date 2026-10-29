import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdConsentPayload } from './AdConsentPanel.tsx';

test('normalizes valid consent preferences and only keeps supported enabled categories', () => {
  assert.deepEqual(normalizeAdConsentPayload({
    adsConsent: true,
    dateOffersConsent: true,
    weddingOffersConsent: true,
    marriagePlanningOptIn: true,
    categoryConsents: { fashion: true, travel: true, political: true, beauty: false }
  }), {
    adsConsent: true,
    dateOffersConsent: true,
    weddingOffersConsent: true,
    marriagePlanningOptIn: true,
    categoryConsents: { fashion: true, travel: true }
  });
});

test('fails closed for malformed API preference payloads', () => {
  for (const value of [null, undefined, false, 0, '', [], 'preferences', { adsConsent: true }]) {
    assert.deepEqual(normalizeAdConsentPayload(value), {
      adsConsent: false,
      dateOffersConsent: false,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: {}
    });
  }
});

test('master consent off clears all dependent flags even if server payload is inconsistent', () => {
  assert.deepEqual(normalizeAdConsentPayload({
    adsConsent: false,
    dateOffersConsent: true,
    weddingOffersConsent: true,
    marriagePlanningOptIn: true,
    categoryConsents: { fashion: true }
  }), {
    adsConsent: false,
    dateOffersConsent: false,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: {}
  });
});

test('marriage-planning opt-in cannot remain enabled without wedding-offer consent', () => {
  assert.deepEqual(normalizeAdConsentPayload({
    adsConsent: true,
    dateOffersConsent: true,
    weddingOffersConsent: false,
    marriagePlanningOptIn: true,
    categoryConsents: {}
  }), {
    adsConsent: true,
    dateOffersConsent: true,
    weddingOffersConsent: false,
    marriagePlanningOptIn: false,
    categoryConsents: {}
  });
});


test('master consent withdrawal overrides malformed or missing dependent preferences', () => {
  for (const value of [
    { adsConsent: false, dateOffersConsent: 'yes', weddingOffersConsent: true, marriagePlanningOptIn: true, categoryConsents: {} },
    { adsConsent: false, dateOffersConsent: true, weddingOffersConsent: null, marriagePlanningOptIn: true, categoryConsents: {} },
    { adsConsent: false, categoryConsents: {} }
  ]) {
    assert.deepEqual(normalizeAdConsentPayload(value), {
      adsConsent: false,
      dateOffersConsent: false,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: {}
    });
  }
});
