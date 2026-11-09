import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVowDeepLink, publishVowDeepLink, subscribeVowDeepLinks } from './mobileDeepLinks.ts';

const token = 'a'.repeat(64);

test('parses supported email verification and password reset app links', () => {
  assert.deepEqual(parseVowDeepLink(`vow://auth/verify-email?token=${token}`), {
    type: 'verify-email', token
  });
  assert.deepEqual(parseVowDeepLink(`vow://auth/reset-password?token=${token}`), {
    type: 'reset-password', token
  });
});

test('parses the non-secret Didit return marker without accepting query data', () => {
  assert.deepEqual(parseVowDeepLink('vow://identity/return'), { type: 'identity-return' });
  assert.equal(parseVowDeepLink('vow://identity/return?token=secret'), null);
});

test('rejects malformed, ambiguous and untrusted app links', () => {
  const invalid = [
    null, undefined, 42, '', 'https://vow.example/auth/verify-email?token=' + token,
    'vow://attacker/auth/verify-email?token=' + token,
    'vow://auth/verify-email?token=' + token + '&token=' + token,
    'vow://auth/verify-email?token=' + token + '&redirect=https://attacker.invalid',
    'vow://auth/verify-email?token=short',
    'vow://auth/verify-email?token=' + 'a'.repeat(513),
    'vow://auth/verify-email?token=' + token + '#fragment',
    'vow://user@auth/verify-email?token=' + token,
    'vow://auth:443/verify-email?token=' + token,
    'vow://auth/unknown?token=' + token,
    'vow://identity/other'
  ];
  for (const value of invalid) assert.equal(parseVowDeepLink(value), null, String(value));
});

test('queues cold-start links until the UI subscribes and suppresses duplicate delivery', () => {
  const coldToken = 'b'.repeat(64);
  const raw = `vow://auth/reset-password?token=${coldToken}`;
  publishVowDeepLink(raw);
  const received: unknown[] = [];
  const unsubscribe = subscribeVowDeepLinks(link => received.push(link));
  assert.deepEqual(received, [{ type: 'reset-password', token: coldToken }]);

  publishVowDeepLink(raw);
  assert.equal(received.length, 1, 'the same one-time token must not be processed twice');
  const nextToken = 'c'.repeat(64);
  publishVowDeepLink(`vow://auth/verify-email?token=${nextToken}`);
  assert.deepEqual(received[1], { type: 'verify-email', token: nextToken });
  unsubscribe();
});
