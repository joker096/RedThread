import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createSumsubAccessToken,
  createSumsubSignature,
  isSumsubConfigured,
  projectSumsubReview,
  verifySumsubWebhook
} from './sumsubIdentity.js';

const configuredEnv = {
  SUMSUB_ENVIRONMENT: 'sandbox',
  SUMSUB_APP_TOKEN: 'sandbox-app-token',
  SUMSUB_SECRET_KEY: 'api-secret',
  SUMSUB_WEBHOOK_SECRET: 'webhook-secret',
  SUMSUB_LEVEL_NAME: 'vow-l2-document-liveness'
};

test('Sumsub is configured only when sandbox credentials and level are present', () => {
  assert.equal(isSumsubConfigured(configuredEnv), true);
  assert.equal(isSumsubConfigured({ ...configuredEnv, SUMSUB_ENVIRONMENT: 'production' }), false);
  assert.equal(isSumsubConfigured({ ...configuredEnv, SUMSUB_WEBHOOK_SECRET: '' }), false);
});

test('Sumsub API signature covers timestamp, method, URI and exact body', () => {
  const expected = createHmac('sha256', 'secret')
    .update('1700000000POST/resources/accessTokens/sdk{"userId":"123e4567-e89b-42d3-a456-426614174000","levelName":"vow-l2-document-liveness","ttlInSecs":600}')
    .digest('hex');
  assert.equal(createSumsubSignature({
    secretKey: 'secret', timestamp: 1700000000, method: 'post',
    path: '/resources/accessTokens/sdk', body: '{"userId":"123e4567-e89b-42d3-a456-426614174000","levelName":"vow-l2-document-liveness","ttlInSecs":600}'
  }), expected);
  assert.throws(() => createSumsubSignature({
    secretKey: 'secret', timestamp: 0, method: 'GET', path: '/x'
  }), /invalid_sumsub_signature_input/);
});

test('Sumsub webhook digest validates raw bytes and rejects unsupported algorithms', () => {
  const rawBody = Buffer.from('{ "type": "applicantReviewed" }');
  const digest = createHmac('sha256', 'webhook-secret').update(rawBody).digest('hex');
  assert.equal(verifySumsubWebhook({
    rawBody, digest, algorithm: 'HMAC_SHA256_HEX', secret: 'webhook-secret'
  }), true);
  assert.equal(verifySumsubWebhook({
    rawBody: Buffer.from(rawBody.toString() + ' '), digest,
    algorithm: 'HMAC_SHA256_HEX', secret: 'webhook-secret'
  }), false);
  assert.equal(verifySumsubWebhook({
    rawBody, digest, algorithm: 'HMAC_SHA1_HEX', secret: 'webhook-secret'
  }), false);
});

test('only completed GREEN and RED applicant reviews become terminal states', () => {
  assert.equal(projectSumsubReview({ type: 'applicantReviewed', reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } }), 'verified');
  assert.equal(projectSumsubReview({ type: 'applicantReviewed', reviewStatus: 'completed', reviewResult: { reviewAnswer: 'RED' } }), 'rejected');
  assert.equal(projectSumsubReview({ type: 'applicantReviewed', reviewStatus: 'pending', reviewResult: { reviewAnswer: 'GREEN' } }), 'pending');
  assert.equal(projectSumsubReview({ type: 'applicantPending', reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } }), 'pending');
});

test('access token is requested for stable opaque account UUID and sandbox config only', async () => {
  let request;
  const token = await createSumsubAccessToken({
    userId: '123e4567-e89b-42d3-a456-426614174000',
    env: configuredEnv,
    now: () => 1700000000000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ token: 'sandbox-sdk-token' }) };
    }
  });
  assert.equal(token, 'sandbox-sdk-token');
  assert.equal(request.url, 'https://api.sumsub.com/resources/accessTokens/sdk');
  assert.equal(request.options.body, JSON.stringify({
    userId: '123e4567-e89b-42d3-a456-426614174000',
    levelName: configuredEnv.SUMSUB_LEVEL_NAME,
    ttlInSecs: 600
  }));
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-App-Token'], configuredEnv.SUMSUB_APP_TOKEN);
  assert.equal(request.options.headers['X-App-Access-Ts'], '1700000000');
  assert.match(request.url, /ttlInSecs=600/);
  await assert.rejects(() => createSumsubAccessToken({
    userId: 'not-an-uuid', env: configuredEnv,
    fetchImpl: async () => { throw new Error('must_not_call'); }
  }), /invalid_sumsub_user_id/);
  await assert.rejects(() => createSumsubAccessToken({
    userId: '123e4567-e89b-42d3-a456-426614174000',
    env: { ...configuredEnv, SUMSUB_ENVIRONMENT: 'production' }
  }), /sumsub_sandbox_not_configured/);
});
