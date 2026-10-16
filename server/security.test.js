import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  isAdultDate,
  isValidEmail,
  normalizeEmail,
  verifyPassword
} from './security.js';

test('password hashes verify only the original password', async () => {
  const encoded = await hashPassword('Correct Horse Battery Staple 42!');
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword('Correct Horse Battery Staple 42!', encoded), true);
  assert.equal(await verifyPassword('wrong password', encoded), false);
  assert.equal(await verifyPassword('anything', 'invalid-hash'), false);
});

test('email normalization and validation are deterministic', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('x'.repeat(250) + '@example.com'), false);
});

test('adult date validation rejects minors and invalid calendar dates', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');
  assert.equal(isAdultDate('2008-10-16', now), true);
  assert.equal(isAdultDate('2008-10-17', now), false);
  assert.equal(isAdultDate('2010-01-01', now), false);
  assert.equal(isAdultDate('2008-02-30', now), false);
  assert.equal(isAdultDate('16-10-2000', now), false);
});

test('session tokens are opaque and stored hashes are not the raw token', () => {
  const token = createSessionToken();
  const digest = hashSessionToken(token);
  assert.equal(token.length >= 40, true);
  assert.equal(digest.length, 64);
  assert.notEqual(digest, token);
  assert.notEqual(hashSessionToken(createSessionToken()), digest);
});
