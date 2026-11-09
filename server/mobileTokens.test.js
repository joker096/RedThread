import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMobileToken,
  hashMobileToken,
  readMobileBearerToken,
  validateMobileDevice
} from './mobileTokens.js';

test('mobile access and refresh tokens are opaque, distinct and hashable only as their own kind', () => {
  const access = createMobileToken('access');
  const refresh = createMobileToken('refresh');
  assert.match(access, /^vow_access_[A-Za-z0-9_-]{43}$/);
  assert.match(refresh, /^vow_refresh_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(access, refresh);
  assert.match(hashMobileToken(access, 'access'), /^[a-f0-9]{64}$/);
  assert.match(hashMobileToken(refresh, 'refresh'), /^[a-f0-9]{64}$/);
  assert.equal(hashMobileToken(access, 'refresh'), null);
  assert.equal(hashMobileToken(refresh, 'access'), null);
  assert.equal(hashMobileToken('not-a-token', 'access'), null);
  assert.equal(hashMobileToken(access, 'unknown'), null);
});

test('mobile bearer parser accepts only a bounded access token authorization header', () => {
  const access = createMobileToken('access');
  assert.equal(readMobileBearerToken(`Bearer ${access}`), access);
  assert.equal(readMobileBearerToken(`bearer ${access}`), access);
  assert.equal(readMobileBearerToken(`Bearer ${createMobileToken('refresh')}`), null);
  assert.equal(readMobileBearerToken(access), null);
  assert.equal(readMobileBearerToken('Bearer token extra'), null);
  assert.equal(readMobileBearerToken('Bearer ' + 'x'.repeat(400)), null);
  assert.equal(readMobileBearerToken(null), null);
});

test('mobile device metadata is normalized and strictly bounded', () => {
  const valid = {
    platform: 'android',
    deviceId: '550e8400-e29b-41d4-a716-446655440000',
    deviceName: '  Pixel test  '
  };
  assert.deepEqual(validateMobileDevice(valid), {
    platform: 'android',
    deviceId: valid.deviceId,
    deviceName: 'Pixel test'
  });
  assert.equal(validateMobileDevice({ ...valid, platform: 'web' }), null);
  assert.equal(validateMobileDevice({ ...valid, deviceId: 'invalid' }), null);
  assert.equal(validateMobileDevice({ ...valid, deviceName: ' ' }), null);
  assert.equal(validateMobileDevice({ ...valid, deviceName: 'x'.repeat(81) }), null);
  assert.equal(validateMobileDevice({ ...valid, deviceName: 'phone\\nforged' }), null);
  assert.equal(validateMobileDevice([]), null);
});

test('unsupported token kinds cannot be minted', () => {
  assert.throws(() => createMobileToken('session'), /Unsupported mobile token kind/);
});
