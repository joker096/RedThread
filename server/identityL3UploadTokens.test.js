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
