import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { appendPrivacyRecoveryEvent } from './privacyRecoveryLedger.js';

const baseEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: 'pseudonym-secret-at-least-32-characters'
};

test('required ledger fails closed when configuration is missing', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: { NODE_ENV: 'production' }, fetchImpl: async () => { throw new Error('must not call'); }
    }),
    /not_configured/
  );
});

test('non-production may skip an unconfigured optional ledger explicitly', async () => {
  const result = await appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
    env: { NODE_ENV: 'test' }
  });
  assert.deepEqual(result, { skipped: true });
});

test('event is pseudonymized, signed and only acknowledged after remote durable acceptance', async () => {
  let captured;
  const result = await appendPrivacyRecoveryEvent({
    eventType: 'voice_intro_consent_withdrawn',
    userId: 'internal-user-uuid',
    resourceId: 'internal-resource-uuid',
    occurredAt: '2026-11-14T07:00:00.000Z'
  }, {
    env: baseEnv,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      captured = { url, options, event: JSON.parse(options.body) };
      return new Response(JSON.stringify({ accepted: true, duplicate: false, sequence: 17 }), {
        status: 201, headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.equal(result.acknowledged, true);
  assert.equal(result.sequence, 17);
  assert.equal(captured.url, 'https://ledger.example/v1/events');
  assert.equal(captured.event.event_type, 'voice_intro_consent_withdrawn');
  assert.notEqual(captured.event.subject_ref, 'internal-user-uuid');
  assert.notEqual(captured.event.resource_ref, 'internal-resource-uuid');
  assert.equal(captured.event.schema_version, 1);
  const expected = createHmac('sha256', baseEnv.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET)
    .update(`1800000000.${captured.options.body}`).digest('hex');
  assert.equal(captured.options.headers['x-ledger-signature'], expected);
});

test('ledger network failure is a hard error when required', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: baseEnv, fetchImpl: async () => { throw new Error('offline'); }
    }),
    /unavailable/
  );
});

test('invalid event types and non-HTTPS endpoints are rejected', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'arbitrary', userId: 'u-1' }, { env: baseEnv }),
    /invalid_privacy_recovery_event/
  );
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: { ...baseEnv, PRIVACY_RECOVERY_LEDGER_URL: 'http://ledger.example' },
      fetchImpl: async () => { throw new Error('must not call'); }
    }),
    /invalid_url/
  );
});

test('malformed or non-success acknowledgement is rejected', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: baseEnv, fetchImpl: async () => new Response('{}', { status: 200 })
    }),
    /invalid_acknowledgement/
  );
});
