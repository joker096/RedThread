import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  decryptGiftAddress,
  encryptGiftAddress,
  normalizeGiftAddress,
  parseGiftAddressVaultKey
} from './giftAddressVault.js';

const address = {
  recipientName: 'Recipient Example',
  phone: '+995 555 123 456',
  addressLine1: '12 Rustaveli Avenue',
  city: 'Tbilisi',
  region: 'Tbilisi',
  postalCode: '0108',
  countryCode: 'GE',
  deliveryInstructions: 'Call on arrival'
};

test('vault key parser accepts exactly one canonical 32-byte base64 key', () => {
  const encoded = randomBytes(32).toString('base64');
  assert.equal(parseGiftAddressVaultKey(encoded)?.length, 32);
  assert.equal(parseGiftAddressVaultKey('not-a-key'), null);
  assert.equal(parseGiftAddressVaultKey(Buffer.alloc(32).toString('hex')), null);
});

test('address normalization rejects unknown shapes and invalid required fields', () => {
  assert.equal(normalizeGiftAddress(address).ok, true);
  assert.equal(normalizeGiftAddress({ ...address, countryCode: 'Georgia' }).ok, false);
  assert.equal(normalizeGiftAddress({ ...address, phone: 'abc' }).ok, false);
  assert.equal(normalizeGiftAddress({ ...address, surprise: 'secret' }).ok, false);
});

test('AES-256-GCM round-trips only with the same order and recipient context', () => {
  const key = randomBytes(32);
  const encrypted = encryptGiftAddress({
    address, orderId: 'order-1', recipientUserId: 'recipient-1', key, keyVersion: '2026-01'
  });
  assert.deepEqual(
    decryptGiftAddress({ encrypted, orderId: 'order-1', recipientUserId: 'recipient-1', key }),
    address
  );
  assert.throws(
    () => decryptGiftAddress({ encrypted, orderId: 'order-2', recipientUserId: 'recipient-1', key })
  );
  assert.throws(
    () => decryptGiftAddress({ encrypted, orderId: 'order-1', recipientUserId: 'recipient-2', key })
  );
});

test('AES-GCM authentication rejects modified ciphertext', () => {
  const key = randomBytes(32);
  const encrypted = encryptGiftAddress({ address, orderId: 'order-1', recipientUserId: 'recipient-1', key });
  const tampered = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => decryptGiftAddress({
    encrypted: tampered, orderId: 'order-1', recipientUserId: 'recipient-1', key
  }));
});

test('invalid key and payload inputs fail closed', () => {
  assert.throws(() => encryptGiftAddress({ address, orderId: 'o', recipientUserId: 'u', key: Buffer.alloc(16) }));
  assert.throws(() => encryptGiftAddress({ address: { ...address, countryCode: 'USA' }, orderId: 'o', recipientUserId: 'u', key: randomBytes(32) }));
});
