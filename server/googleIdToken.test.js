import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdTokenClaims } from './googleIdToken.js';

const NOW = 1_800_000_000_000;
const CLIENT_ID = 'vow-test-client.apps.googleusercontent.com';
const NONCE = 'n'.repeat(43);
const CREDENTIAL = 'x'.repeat(120);

function fixture(overrides = {}, verify = async () => {}) {
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 300,
    iat: Math.floor(NOW / 1000) - 10,
    sub: 'google-subject-123',
    email: ' Person@Example.com ',
    email_verified: true,
    nonce: NONCE,
    name: ' Example Person ',
    ...overrides
  };
  const calls = [];
  const oauthClient = {
    verifyIdToken: async args => {
      calls.push(args);
      await verify(args);
      return { getPayload: () => payload };
    }
  };
  return { payload, calls, oauthClient };
}

async function verify(overrides = {}, verifier) {
  const f = fixture(overrides, verifier);
  const identity = await verifyGoogleIdTokenClaims({
    credential: CREDENTIAL,
    expectedNonce: NONCE,
    clientId: CLIENT_ID,
    oauthClient: f.oauthClient,
    now: NOW
  });
  return { identity, ...f };
}

test('accepts a verified Google token and normalizes the identity', async () => {
  const { identity, calls } = await verify();
  assert.deepEqual(identity, {
    subject: 'google-subject-123',
    email: 'person@example.com',
    displayName: 'Example Person'
  });
  assert.deepEqual(calls, [{ idToken: CREDENTIAL, audience: CLIENT_ID }]);
});

test('rejects credentials outside the accepted size bounds before calling Google', async () => {
  const f = fixture();
  await assert.rejects(verifyGoogleIdTokenClaims({
    credential: 'short', expectedNonce: NONCE, clientId: CLIENT_ID,
    oauthClient: f.oauthClient, now: NOW
  }), /invalid_google_credential/);
  assert.equal(f.calls.length, 0);
});

test('rejects Google verifier signature/verification failures', async () => {
  const f = fixture();
  f.oauthClient.verifyIdToken = async () => { throw new Error('invalid signature'); };
  await assert.rejects(verifyGoogleIdTokenClaims({
    credential: CREDENTIAL, expectedNonce: NONCE, clientId: CLIENT_ID,
    oauthClient: f.oauthClient, now: NOW
  }), /invalid signature/);
});

for (const [label, claims] of [
  ['issuer', { iss: 'https://attacker.example' }],
  ['audience', { aud: 'another-client.apps.googleusercontent.com' }],
  ['missing authorized party for multiple audiences', { aud: [CLIENT_ID, 'another-client.apps.googleusercontent.com'] }],
  ['mismatched authorized party', { azp: 'another-client.apps.googleusercontent.com' }],
  ['expired token', { exp: Math.floor(NOW / 1000) }],
  ['future issued-at', { iat: Math.floor(NOW / 1000) + 61 }],
  ['unverified email', { email_verified: false }],
  ['missing subject', { sub: '' }],
  ['oversized subject', { sub: 's'.repeat(256) }],
  ['invalid email', { email: 'not-an-email' }],
  ['wrong nonce', { nonce: 'z'.repeat(43) }],
  ['missing nonce', { nonce: undefined }]
]) {
  test(`rejects token with invalid ${label} claim`, async () => {
    const f = fixture(claims);
    await assert.rejects(verifyGoogleIdTokenClaims({
      credential: CREDENTIAL, expectedNonce: NONCE, clientId: CLIENT_ID,
      oauthClient: f.oauthClient, now: NOW
    }), /invalid_google_identity/);
  });
}

test('rejects missing verifier configuration and invalid expected nonce', async () => {
  const f = fixture();
  await assert.rejects(verifyGoogleIdTokenClaims({
    credential: CREDENTIAL, expectedNonce: NONCE, clientId: '',
    oauthClient: f.oauthClient, now: NOW
  }), /google_sign_in_not_configured/);
  await assert.rejects(verifyGoogleIdTokenClaims({
    credential: CREDENTIAL, expectedNonce: 'short', clientId: CLIENT_ID,
    oauthClient: f.oauthClient, now: NOW
  }), /invalid_google_identity/);
});

test('accepts the legacy Google issuer spelling and an audience array containing this client', async () => {
  const { identity } = await verify({
    iss: 'accounts.google.com',
    aud: [CLIENT_ID, 'another-audience'],
    azp: CLIENT_ID
  });
  assert.equal(identity.subject, 'google-subject-123');
});
