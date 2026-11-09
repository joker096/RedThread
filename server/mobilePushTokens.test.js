import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptMobilePushToken,
  encryptMobilePushToken,
  fingerprintMobilePushToken,
  parseMobilePushTokenEncryptionKey,
  safeMobilePushPayload,
  validateMobilePushToken
} from './mobilePushTokens.js';

const key = Buffer.alloc(32, 9);
const fcm = 'fcm-token:abcdefghijklmnopqrstuvwxyz_0123456789';
const apns = 'a'.repeat(64);

test('mobile push tokens are platform-validated without storing plaintext', () => {
  assert.equal(validateMobilePushToken(fcm, 'android'), true);
  assert.equal(validateMobilePushToken(apns, 'ios'), true);
  assert.equal(validateMobilePushToken(fcm, 'ios'), false);
  assert.equal(validateMobilePushToken(apns, 'android'), false);
  assert.equal(validateMobilePushToken('short', 'android'), false);
  assert.equal(validateMobilePushToken('token with spaces and symbols !!!', 'android'), false);
  assert.equal(validateMobilePushToken(fcm, 'web'), false);
});

test('mobile push tokens use authenticated encryption and keyed fingerprints', () => {
  const encrypted = encryptMobilePushToken(fcm, key);
  assert.notEqual(encrypted.toString('utf8').includes(fcm), true);
  assert.equal(decryptMobilePushToken(encrypted, key), fcm);
  assert.equal(fingerprintMobilePushToken(fcm, key), fingerprintMobilePushToken(fcm, key));
  assert.notEqual(fingerprintMobilePushToken(fcm, key), fingerprintMobilePushToken(fcm, Buffer.alloc(32, 8)));
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptMobilePushToken(tampered, key), /mobile_push_token_authentication_failed/);
});

test('mobile push encryption key parser fails closed on invalid configuration', () => {
  assert.equal(parseMobilePushTokenEncryptionKey('a'.repeat(64)).length, 32);
  assert.equal(parseMobilePushTokenEncryptionKey('not-a-key'), null);
  assert.equal(parseMobilePushTokenEncryptionKey('a'.repeat(63)), null);
});

test('push payloads are generic and contain no match, message, identity or gift details', () => {
  assert.deepEqual(safeMobilePushPayload('new_message'), {
    title: 'Vow', body: 'You have a new message.',
    route: '/chats', data: { type: 'new_message', route: '/chats' }
  });
  assert.deepEqual(safeMobilePushPayload('gift_request'), {
    title: 'Vow', body: 'You have a gift request to review.',
    route: '/gifts', data: { type: 'gift_request', route: '/gifts' }
  });
  assert.equal(safeMobilePushPayload('unknown'), null);
});
