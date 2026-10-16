import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStripeWebhookSignature } from './stripeWebhookSecurity.js';

function signature(body, secret, timestamp) {
  const digest = createHmac('sha256', secret).update(String(timestamp) + '.').update(body).digest('hex');
  return 't=' + timestamp + ',v1=' + digest;
}

test('accepts a correctly signed recent Stripe payload', () => {
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const body = Buffer.from('{"id":"evt_test","type":"checkout.session.completed"}');
  assert.equal(verifyStripeWebhookSignature(body, signature(body, 'whsec_test', timestamp), 'whsec_test', now), true);
});

test('rejects modified payloads, wrong secrets and stale signatures', () => {
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const body = Buffer.from('{"id":"evt_test"}');
  const validHeader = signature(body, 'whsec_test', timestamp);
  assert.equal(verifyStripeWebhookSignature(Buffer.from('{"id":"evt_other"}'), validHeader, 'whsec_test', now), false);
  assert.equal(verifyStripeWebhookSignature(body, validHeader, 'wrong_secret', now), false);
  assert.equal(verifyStripeWebhookSignature(body, signature(body, 'whsec_test', timestamp - 600), 'whsec_test', now), false);
  assert.equal(verifyStripeWebhookSignature(body, 't=bad,v1=xyz', 'whsec_test', now), false);
});
