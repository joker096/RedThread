import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { canonicalizeDiditPayload, createDiditSession, isDiditConfigured, isDiditStatus, projectDiditStatus, verifyDiditWebhook } from './diditIdentity.js';
const env = {
  DIDIT_ENVIRONMENT: 'sandbox', DIDIT_SANDBOX_KEY_CONFIRMED: 'true', DIDIT_API_KEY: 'sandbox-api-key',
  DIDIT_WORKFLOW_ID: '123e4567-e89b-42d3-a456-426614174000',
  DIDIT_APPLICATION_ID: '123e4567-e89b-42d3-a456-426614174001',
  DIDIT_WEBHOOK_SECRET: 'webhook-secret', APP_ORIGIN: 'https://vow.example'
};
test('Didit configuration is complete and sandbox-only', () => {
  assert.equal(isDiditConfigured(env), true);
  assert.equal(isDiditConfigured({ ...env, DIDIT_ENVIRONMENT: 'live' }), false);
  assert.equal(isDiditConfigured({ ...env, DIDIT_SANDBOX_KEY_CONFIRMED: 'false' }), false);
  assert.equal(isDiditConfigured({ ...env, DIDIT_WEBHOOK_SECRET: '' }), false);
  assert.equal(isDiditConfigured({ ...env, DIDIT_WORKFLOW_ID: 'bad' }), false);
});
test('V3 canonical payload sorts nested keys, preserves arrays and Unicode', () => {
  assert.equal(canonicalizeDiditPayload({ z: 'Ж', nested: { b: 2, a: 1 }, list: [{ z: true, a: false }, 3] }),
    '{"list":[{"a":false,"z":true},3],"nested":{"a":1,"b":2},"z":"Ж"}');
  assert.throws(() => canonicalizeDiditPayload([]), /invalid_didit_webhook_payload/);
  assert.equal(canonicalizeDiditPayload({ '2': 'second', '10': 'tenth' }), '{"10":"tenth","2":"second"}');
});
test('webhook HMAC authenticates the entire canonical body and enforces freshness', () => {
  const payload = { event_id: '123e4567-e89b-42d3-a456-426614174002', webhook_type: 'status.updated',
    timestamp: 1700000000, session_id: '123e4567-e89b-42d3-a456-426614174003',
    status: 'Approved', decision: { id_verifications: [{ status: 'Approved', name: 'José' }] } };
  const canonical = canonicalizeDiditPayload(payload);
  const digest = createHmac('sha256', 'webhook-secret').update(canonical).digest('hex');
  const now = () => 1700000000000;
  assert.equal(verifyDiditWebhook({ payload, signature: digest, timestampHeader: '1700000000', secret: 'webhook-secret', now }), true);
  assert.equal(verifyDiditWebhook({ payload: { ...payload, status: 'Declined' }, signature: digest, timestampHeader: '1700000000', secret: 'webhook-secret', now }), false);
  const previous = createHmac('sha256', 'old-secret').update(canonical).digest('hex');
  assert.equal(verifyDiditWebhook({ payload, previousSignature: previous, timestampHeader: '1700000000', secret: 'webhook-secret', previousSecret: 'old-secret', now }), true);
  assert.equal(verifyDiditWebhook({ payload, signature: digest, timestampHeader: '1699999000', secret: 'webhook-secret', now }), false);
  assert.equal(verifyDiditWebhook({ payload, signature: digest, timestampHeader: '1700000001', secret: 'webhook-secret', now }), false);
});
test('Sandbox verdicts never become real identity verification', () => {
  for (const status of ['Approved', 'Declined', 'In Review', 'Kyc Expired']) assert.equal(projectDiditStatus(status), 'pending');
  assert.equal(projectDiditStatus('unknown'), null);
  assert.equal(isDiditStatus('Resubmitted'), true);
  assert.equal(isDiditStatus('approved'), false);
});
test('session creation keeps API key server-side and validates the hosted URL', async () => {
  let request;
  const result = await createDiditSession({
    userId: '123e4567-e89b-42d3-a456-426614174010', env, callbackOrigin: 'https://vow.example',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ session_id: '123e4567-e89b-42d3-a456-426614174011',
        workflow_id: env.DIDIT_WORKFLOW_ID, url: 'https://verify.didit.me/en/session/abc123', status: 'Not Started' }) };
    }
  });
  assert.equal(request.url, 'https://verification.didit.me/v3/session/');
  assert.equal(request.options.headers['x-api-key'], env.DIDIT_API_KEY);
  assert.deepEqual(JSON.parse(request.options.body), {
    workflow_id: env.DIDIT_WORKFLOW_ID, vendor_data: '123e4567-e89b-42d3-a456-426614174010',
    callback: 'https://vow.example/?identityVerification=return', language: 'ru'
  });
  assert.equal(result.sessionId, '123e4567-e89b-42d3-a456-426614174011');
  assert.equal(result.verificationUrl, 'https://verify.didit.me/en/session/abc123');
  await assert.rejects(() => createDiditSession({ userId: 'bad', env, fetchImpl: async () => { throw new Error('must_not_call'); } }), /invalid_didit_user_id/);
  await assert.rejects(() => createDiditSession({ userId: '123e4567-e89b-42d3-a456-426614174010',
    env: { ...env, DIDIT_ENVIRONMENT: 'live' }, fetchImpl: async () => { throw new Error('must_not_call'); } }), /didit_sandbox_not_configured/);
  await assert.rejects(() => createDiditSession({ userId: '123e4567-e89b-42d3-a456-426614174010',
    env, callbackOrigin: 'https://attacker.example', fetchImpl: async () => ({ ok: true, json: async () => ({
      session_id: '123e4567-e89b-42d3-a456-426614174011', workflow_id: env.DIDIT_WORKFLOW_ID,
      url: 'https://evil.example/steal', status: 'Not Started' }) }) }), /didit_session_response_invalid/);
});
