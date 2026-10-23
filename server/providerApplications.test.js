import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProviderApplication,
  PROVIDER_APPLICATION_CATEGORIES
} from './providerApplications.js';

const validApplication = {
  contactName: 'Ирина',
  businessName: 'Фотостудия',
  email: 'hello@example.test',
  category: 'photography',
  country: 'Грузия',
  city: 'Тбилиси',
  serviceDescription: 'Свадебная фотосъёмка и портреты.',
  websiteUrl: 'https://example.test/',
  consent: true
};

test('accepts a minimal provider application and normalizes contact email and website', () => {
  const result = normalizeProviderApplication(validApplication);
  assert.equal(result.error, undefined);
  assert.equal(result.value.email, 'hello@example.test');
  assert.equal(result.value.websiteUrl, 'https://example.test/');
  assert.equal(result.value.publicRegistryUrl, null);
});

test('supports all reviewed service categories including cafes', () => {
  for (const category of PROVIDER_APPLICATION_CATEGORIES) {
    assert.equal(normalizeProviderApplication({ ...validApplication, category }).error, undefined);
  }
});

test('rejects missing consent, invalid categories, blank text and overlong fields', () => {
  for (const invalid of [
    { ...validApplication, consent: false },
    { ...validApplication, category: 'unreviewed' },
    { ...validApplication, businessName: '   ' },
    { ...validApplication, serviceDescription: 'x'.repeat(1001) },
    { ...validApplication, email: 'invalid' }
  ]) {
    assert.equal(normalizeProviderApplication(invalid).error, 'invalid_provider_application');
  }
});

test('optional links must use HTTPS and cannot contain embedded credentials', () => {
  for (const websiteUrl of [
    'http://example.test',
    'javascript:alert(1)',
    'https://user:password@example.test',
    'not a url'
  ]) {
    assert.equal(
      normalizeProviderApplication({ ...validApplication, websiteUrl }).error,
      'invalid_provider_application'
    );
  }
});

test('rejects non-public registry links and ignores no consent implicitly', () => {
  const result = normalizeProviderApplication({
    ...validApplication,
    publicRegistryUrl: 'https://registry.example/license/123'
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.publicRegistryUrl, 'https://registry.example/license/123');
  assert.equal(normalizeProviderApplication({ ...validApplication, consent: undefined }).error, 'invalid_provider_application');
});
