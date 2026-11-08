import test from 'node:test';
import assert from 'node:assert/strict';
import { emailDeliveryConfigured } from './emailDeliveryConfig.js';

const base = {
  NODE_ENV: 'development',
  APP_ORIGIN: 'http://localhost:3000',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'Vow <noreply@vowmail.org>'
};

test('email delivery is enabled only with Resend, a real sender address and a valid app URL', () => {
  assert.equal(emailDeliveryConfigured(base), true);
  assert.equal(emailDeliveryConfigured({
    ...base,
    NODE_ENV: 'production',
    APP_URL: 'https://vowapp.org'
  }), true);
});

test('email delivery stays disabled when the sender is missing or a placeholder', () => {
  for (const EMAIL_FROM of ['', 'noreply@example.com', 'noreply@example.org', 'Vow <noreply@example.test>', 'not-an-email']) {
    assert.equal(emailDeliveryConfigured({ ...base, EMAIL_FROM }), false);
  }
});

test('email delivery rejects sender header injection and missing provider credentials', () => {
  assert.equal(emailDeliveryConfigured({ ...base, EMAIL_FROM: 'Vow\r\nBcc: attacker@example.org' }), false);
  assert.equal(emailDeliveryConfigured({ ...base, RESEND_API_KEY: ' ' }), false);
  assert.equal(emailDeliveryConfigured({ ...base, EMAIL_PROVIDER: 'smtp' }), false);
});

test('production email delivery requires a non-placeholder HTTPS application origin', () => {
  assert.equal(emailDeliveryConfigured({ ...base, NODE_ENV: 'production', APP_URL: 'http://vow.example.org' }), false);
  assert.equal(emailDeliveryConfigured({ ...base, NODE_ENV: 'production', APP_URL: 'https://example.com' }), false);
  assert.equal(emailDeliveryConfigured({ ...base, NODE_ENV: 'production', APP_URL: 'https://vow.example.org' }), false);
  assert.equal(emailDeliveryConfigured({ ...base, EMAIL_FROM: 'Vow <noreply@mail.example.org>' }), false);
  assert.equal(emailDeliveryConfigured({ ...base, NODE_ENV: 'production', APP_URL: 'https://vow.localhost' }), false);
});
