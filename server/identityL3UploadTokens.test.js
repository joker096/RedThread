import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdentityL3UploadToken,
  hashIdentityL3UploadToken,
  IDENTITY_L3_UPLOAD_TOKEN_LIFETIME_MINUTES,
  IdentityL3UploadTokenError
} from './identityL3UploadTokens.js';

test('L3 upload capability is cryptographically random and URL-safe', () => {
  const first = createIdentityL3UploadToken();
  const second = createIdentityL3UploadToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
});

test('L3 upload capability hashes deterministically without exposing plaintext', () => {
  const token = createIdentityL3UploadToken();
  const digest = hashIdentityL3UploadToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hashIdentityL3UploadToken(token), digest);
  assert.notEqual(digest, token);
});

test('L3 upload capability rejects malformed bearer values', () => {
  for (const value of ['', 'short', 'x'.repeat(200), null, undefined, 123]) {
    assert.throws(
      () => hashIdentityL3UploadToken(value),
      error => error instanceof IdentityL3UploadTokenError &&
        error.code === 'l3_upload_token_invalid'
    );
  }
});

test('L3 upload capability lifetime is short and bounded', () => {
  assert.equal(IDENTITY_L3_UPLOAD_TOKEN_LIFETIME_MINUTES, 10);
});


function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const next = responses.shift();
      if (!next) throw new Error('unexpected_query');
      if (next.error) throw next.error;
      return next;
    }
  };
}

test('upload capability issuance fails closed unless persisted account and Didit L2 are valid', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ account_status: 'active', gender: 'male', identity_status: 'verified', provider_environment: 'sandbox', l3_consent_active: true }], rowCount: 1 }
  ]);
  await assert.rejects(
    issueIdentityL3UploadCapability(client, { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    error => error.code === 'l3_upload_requires_live_l2'
  );
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].sql, /FOR UPDATE OF u, p, iv/);\n  assert.match(client.calls[1].sql, /identity_l3_consents/);\n  assert.equal(client.calls[1].params[0], 1);
});

test('upload capability issuance persists only a digest and returns plaintext once', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ account_status: 'active', gender: 'male', identity_status: 'verified', provider_environment: 'live', l3_consent_active: true }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'draft' }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ expires_at: '2026-11-01T12:10:00.000Z' }], rowCount: 1 }
  ]);
  const result = await issueIdentityL3UploadCapability(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  });
  assert.match(result.uploadToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.submissionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(result.maxBytes, 104857600);
  assert.deepEqual(result.acceptedMimeTypes, ['video/mp4', 'video/webm']);
  const insert = client.calls.find(call => /INSERT INTO identity_l3_upload_tokens/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[2], hashIdentityL3UploadToken(result.uploadToken));
  assert.notEqual(insert.params[2], result.uploadToken);
});

test('upload capability consumption binds the token to the authenticated user and submission', async () => {
  const { consumeIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const token = createIdentityL3UploadToken();
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ account_status: 'active', gender: 'male', identity_status: 'verified', provider_environment: 'live' }], rowCount: 1 },
    { rows: [{ token_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', submission_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'upload_authorized' }], rowCount: 1 },
    { rows: [{ submission_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], rowCount: 1 }
  ]);
  const result = await consumeIdentityL3UploadCapability(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadToken: token
  });
  assert.equal(result.submissionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const lookup = client.calls.find(call => /FROM identity_l3_upload_tokens t/.test(call.sql));
  assert.equal(lookup.params[0], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(lookup.params[1], hashIdentityL3UploadToken(token));
  assert.match(lookup.sql, /t\.expires_at > NOW\(\)/);
});

test('upload capability issuance fails closed when explicit current L3 consent is absent', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{
      account_status: 'active', gender: 'male', identity_status: 'verified',
      provider_environment: 'live', l3_consent_active: false
    }], rowCount: 1 }
  ]);
  await assert.rejects(
    issueIdentityL3UploadCapability(client, { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    error => error.code === 'l3_consent_required'
  );
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].sql, /c\.withdrawn_at IS NULL/);
});
