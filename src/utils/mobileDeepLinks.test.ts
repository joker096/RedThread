import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVowDeepLink, publishVowDeepLink, subscribeVowDeepLinks } from './mobileDeepLinks.ts';

const token = 'a'.repeat(64);
const appHost = 'app.vow-example.test';

test('parses verified HTTPS email verification and password reset app links', () => {
  assert.deepEqual(parseVowDeepLink(`https://${appHost}/?verifyEmail=${token}`, appHost), {
    type: 'verify-email', token
  });
  assert.deepEqual(parseVowDeepLink(`https://${appHost}/?resetPassword=${token}`, appHost), {
    type: 'reset-password', token
  });
  assert.equal(parseVowDeepLink(`https://${appHost}/?verifyEmail=${token}`), null,
    'token-bearing HTTPS links require an explicitly configured host');
});

test('parses Didit return only through the configured verified HTTPS host', () => {
  assert.deepEqual(parseVowDeepLink(`https://${appHost}/?identityVerification=return`, appHost), {
    type: 'identity-return'
  });
  assert.equal(parseVowDeepLink('https://attacker.invalid/?identityVerification=return', appHost), null);
  assert.equal(parseVowDeepLink(`https://${appHost}/?identityVerification=return&verifyEmail=${token}`, appHost), null);
});

test('parses the non-secret custom-scheme identity return marker', () => {
  assert.deepEqual(parseVowDeepLink('vow://identity/return'), { type: 'identity-return' });
  assert.equal(parseVowDeepLink('vow://identity/return?token=secret'), null);
  assert.equal(parseVowDeepLink(`vow://auth/verify-email?token=${token}`), null,
    'custom schemes must never carry account action tokens');
});

test('rejects malformed, ambiguous and unverified HTTPS app links', () => {
  const invalid = [
    null, undefined, 42, '',
    `https://attacker.invalid/?verifyEmail=${token}`,
    `http://${appHost}/?verifyEmail=${token}`,
    `https://${appHost}/?verifyEmail=${token}&verifyEmail=${token}`,
    `https://${appHost}/?verifyEmail=${token}&redirect=https://attacker.invalid`,
    `https://${appHost}/?verifyEmail=${token}&resetPassword=${token}`,
    `https://${appHost}/?verifyEmail=short`,
    `https://${appHost}/?verifyEmail=${'a'.repeat(513)}`,
    `https://${appHost}/?verifyEmail=${token}#fragment`,
    `https://user@${appHost}/?verifyEmail=${token}`,
    `https://${appHost}/unexpected?verifyEmail=${token}`,
    'vow://attacker/identity/return'
  ];
  for (const value of invalid) assert.equal(parseVowDeepLink(value, appHost), null, String(value));
});

test('rejects invalid configured app-link hosts', () => {
  for (const host of ['', 'app.vow-example.test/path', 'app.vow-example.test:443', 'https://app.vow-example.test']) {
    assert.equal(parseVowDeepLink(`https://app.vow-example.test/?verifyEmail=${token}`, host), null);
  }
});

test('queues cold-start links until the UI subscribes and suppresses duplicate delivery', () => {
  const coldToken = 'b'.repeat(64);
  const raw = `https://${appHost}/?resetPassword=${coldToken}`;
  publishVowDeepLink(raw, appHost);
  const received: unknown[] = [];
  const unsubscribe = subscribeVowDeepLinks(link => received.push(link));
  assert.deepEqual(received, [{ type: 'reset-password', token: coldToken }]);

  publishVowDeepLink(raw, appHost);
  assert.equal(received.length, 1, 'the same one-time token must not be processed twice');
  const nextToken = 'c'.repeat(64);
  publishVowDeepLink(`https://${appHost}/?verifyEmail=${nextToken}`, appHost);
  assert.deepEqual(received[1], { type: 'verify-email', token: nextToken });
  unsubscribe();
});
