import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptGiftAddressDraft, encryptGiftAddressDraft, parseGiftAddressDraftKey,
  parseGiftAddressDraftKeyring, resolveGiftAddressDraftExpiry,
  GIFT_ADDRESS_DRAFT_CONSENT_VERSION, GIFT_ADDRESS_DRAFT_TTL_MS
} from './giftAddressDraft.js';

const keyA = Buffer.alloc(32, 7).toString('base64');
const keyB = Buffer.alloc(32, 8).toString('base64');
const keyring = parseGiftAddressDraftKeyring({
  keyringValue: JSON.stringify({ v1: keyA, v2: keyB }), activeKeyVersion: 'v2'
});
const address = {
  recipientName: 'Alex Example', phone: '+995 555 123456',
  addressLine1: 'Rustaveli 1', city: 'Tbilisi', countryCode: 'GE'
};

test('draft encryption is AES-GCM authenticated and uses an independent keyring', () => {
  const encrypted = encryptGiftAddressDraft({ address, orderId: 'order-1', recipientUserId: 'recipient-1', keyring });
  assert.equal(encrypted.keyVersion, 'v2');
  assert.deepEqual(decryptGiftAddressDraft({ encrypted, orderId: 'order-1', recipientUserId: 'recipient-1', keyring }), address);
  assert.throws(() => decryptGiftAddressDraft({ encrypted, orderId: 'order-2', recipientUserId: 'recipient-1', keyring }));
  const tampered = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => decryptGiftAddressDraft({ encrypted: tampered, orderId: 'order-1', recipientUserId: 'recipient-1', keyring }));
});

test('draft keyring rejects malformed, duplicate, and missing active keys', () => {
  assert.equal(parseGiftAddressDraftKey('not-a-key'), null);
  assert.equal(parseGiftAddressDraftKeyring({ keyringValue: '{bad', activeKeyVersion: 'v1' }), null);
  assert.equal(parseGiftAddressDraftKeyring({ keyringValue: JSON.stringify({ v1: keyA, v2: keyA }), activeKeyVersion: 'v1' }), null);
  assert.equal(parseGiftAddressDraftKeyring({ keyringValue: JSON.stringify({ v1: keyA }), activeKeyVersion: 'v2' }), null);
});

test('draft expiry is bounded to at most 24 hours', () => {
  const now = 1_800_000_000_000;
  assert.equal(resolveGiftAddressDraftExpiry({ now }).getTime(), now + GIFT_ADDRESS_DRAFT_TTL_MS);
  assert.throws(() => resolveGiftAddressDraftExpiry({ now, ttlMs: GIFT_ADDRESS_DRAFT_TTL_MS + 1 }));
  assert.throws(() => resolveGiftAddressDraftExpiry({ now, ttlMs: 1000 }));
  assert.equal(GIFT_ADDRESS_DRAFT_CONSENT_VERSION, 1);
});

test('draft encryption refuses a key reused by the verified-address Vault', () => {
  const previous = process.env.GIFT_ADDRESS_VAULT_KEY;
  process.env.GIFT_ADDRESS_VAULT_KEY = keyA;
  try {
    assert.equal(parseGiftAddressDraftKeyring({
      keyringValue: JSON.stringify({ draft: keyA }),
      activeKeyVersion: 'draft'
    }), null);
  } finally {
    if (previous === undefined) delete process.env.GIFT_ADDRESS_VAULT_KEY;
    else process.env.GIFT_ADDRESS_VAULT_KEY = previous;
  }
});
