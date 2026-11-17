import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGiftProviderWebhookHandler } from './giftProviderWebhook.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request({ body = Buffer.from('{"id":"evt_1"}'), headers = {} } = {}) {
  return { params: { providerKey: 'sandbox_provider' }, headers, body };
}

const verifiedPayment = overrides => ({
  providerAccountId: 'acct_test',
  environment: 'sandbox',
  eventId: 'evt_1',
  eventType: 'payment.updated',
  occurredAt: '2026-11-17T10:00:00.000Z',
  providerReference: 'txn_test_123',
  amountMinorUnits: 12500,
  currency: 'GEL',
  ...overrides
});

const configuredProvider = verifyWebhook => ({
  accountId: 'acct_test',
  environment: 'sandbox',
  verifyWebhook
});

test('gift webhook ingress fails closed when no provider verifier is selected', async () => {
  const res = response();
  let calls = 0;
  const handler = createGiftProviderWebhookHandler({
    pool: { query: async () => { calls += 1; } },
    providers: {}
  });
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'gift_provider_webhook_not_configured');
  assert.equal(calls, 0);
});

test('gift webhook ingress requires exact raw bytes and a bounded nonempty body', async () => {
  const handler = createGiftProviderWebhookHandler({
    pool: { query: async () => ({ rows: [{ result: 'inserted' }] }) },
    providers: { sandbox_provider: configuredProvider(async () => verifiedPayment()) }
  });
  const res = response();
  await handler(request({ body: { id: 'evt_1' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_gift_provider_webhook_body');
});

test('gift webhook ingress delegates raw-body verification and persists only hash plus exact routing metadata', async () => {
  const rawBody = Buffer.from('{"id":"evt_1","amount":12500}');
  let verifierInput;
  let queryArgs;
  const handler = createGiftProviderWebhookHandler({
    pool: { query: async (_sql, args) => { queryArgs = args; return { rows: [{ result: 'inserted' }] }; } },
    providers: { sandbox_provider: configuredProvider(async input => {
      verifierInput = input;
      return verifiedPayment();
    }) }
  });
  const res = response();
  await handler(request({ body: rawBody, headers: { 'x-signature': 'test-signature' } }), res);
  assert.equal(verifierInput.rawBody, rawBody);
  assert.equal(verifierInput.headers['x-signature'], 'test-signature');
  assert.equal(queryArgs[0], 'sandbox_provider');
  assert.equal(queryArgs[1], 'evt_1');
  assert.equal(queryArgs[2], 'payment.updated');
  assert.equal(queryArgs[3], createHash('sha256').update(rawBody).digest('hex'));
  assert.equal(queryArgs[4], '2026-11-17T10:00:00.000Z');
  assert.deepEqual(queryArgs.slice(5), ['acct_test', 'sandbox', 'txn_test_123', 12500, 'GEL']);
  assert.deepEqual(res.body, { received: true, duplicate: false, quarantined: false });
});

test('gift webhook ingress rejects missing or malformed payment identity metadata', async () => {
  const handler = createGiftProviderWebhookHandler({
    pool: { query: async () => { throw new Error('must not persist'); } },
    providers: { sandbox_provider: configuredProvider(async () => verifiedPayment({ providerReference: '', amountMinorUnits: 0 })) }
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_gift_provider_payment_metadata');
});

test('gift webhook ingress rejects verifier errors, wrong account, wrong environment and production configuration', async () => {
  const mismatch = response();
  await createGiftProviderWebhookHandler({
    pool: { query: async () => { throw new Error('must not persist'); } },
    providers: { sandbox_provider: configuredProvider(async () => verifiedPayment({ providerAccountId: 'acct_other' })) }
  })(request(), mismatch);
  assert.equal(mismatch.statusCode, 401);
  assert.equal(mismatch.body.error, 'untrusted_gift_provider_webhook_event');

  const invalidSignature = response();
  await createGiftProviderWebhookHandler({
    pool: { query: async () => { throw new Error('must not persist'); } },
    providers: { sandbox_provider: configuredProvider(async () => { throw new Error('bad signature'); }) }
  })(request(), invalidSignature);
  assert.equal(invalidSignature.statusCode, 401);
  assert.equal(invalidSignature.body.error, 'invalid_gift_provider_webhook_signature');

  const production = response();
  await createGiftProviderWebhookHandler({
    pool: { query: async () => { throw new Error('must not persist'); } },
    providers: { sandbox_provider: { accountId: 'acct_live', environment: 'production', verifyWebhook: async () => verifiedPayment() } }
  })(request(), production);
  assert.equal(production.statusCode, 503);
});

test('gift webhook ingress returns duplicate and quarantined conflict outcomes without logging payloads', async () => {
  for (const [dbResult, expectedStatus, expectedBody] of [
    ['duplicate', 200, { received: true, duplicate: true, quarantined: false }],
    ['conflict', 202, { received: true, duplicate: false, quarantined: true }]
  ]) {
    const handler = createGiftProviderWebhookHandler({
      pool: { query: async () => ({ rows: [{ result: dbResult }] }) },
      providers: { sandbox_provider: configuredProvider(async () => verifiedPayment()) }
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, expectedStatus);
    assert.deepEqual(res.body, expectedBody);
  }
});
