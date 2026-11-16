import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  decryptGiftAddress,
  encryptGiftAddress,
  normalizeGiftAddress,
  parseGiftAddressVaultKey,
  parseGiftAddressVaultKeyring,
  revokeGiftAddressVaultEntry
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
    () => decryptGiftAddress({
      encrypted: { ...encrypted, keyVersion: '2026-02' },
      orderId: 'order-1',
      recipientUserId: 'recipient-1',
      key
    })
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


test('versioned gift vault keyring encrypts with active version and decrypts by stored version', () => {
  const oldKey = randomBytes(32);
  const activeKey = randomBytes(32);
  const keyring = parseGiftAddressVaultKeyring({
    keyringValue: JSON.stringify({
      '2026-01': oldKey.toString('base64'),
      '2026-02': activeKey.toString('base64')
    }),
    activeKeyVersion: '2026-02'
  });
  assert.ok(keyring?.keys instanceof Map);
  const encrypted = encryptGiftAddress({
    address, orderId: 'order-rotate', recipientUserId: 'recipient-rotate', key: keyring
  });
  assert.equal(encrypted.keyVersion, '2026-02');
  assert.deepEqual(
    decryptGiftAddress({
      encrypted, orderId: 'order-rotate', recipientUserId: 'recipient-rotate', key: keyring
    }),
    address
  );
  assert.throws(() => decryptGiftAddress({
    encrypted: { ...encrypted, keyVersion: 'missing-version' },
    orderId: 'order-rotate',
    recipientUserId: 'recipient-rotate',
    key: keyring
  }), /gift_address_vault_key_version_unavailable/);
  oldKey.fill(0);
  activeKey.fill(0);
  for (const key of keyring.keys.values()) key.fill(0);
});

test('versioned gift vault keyring rejects invalid or missing active versions', () => {
  const encoded = randomBytes(32).toString('base64');
  assert.equal(parseGiftAddressVaultKeyring({
    keyringValue: JSON.stringify({ '2026-01': encoded }),
    activeKeyVersion: 'missing'
  }), null);
  assert.equal(parseGiftAddressVaultKeyring({
    keyringValue: '{invalid',
    activeKeyVersion: '2026-01'
  }), null);
  const reusedKey = randomBytes(32).toString('base64');
  assert.equal(parseGiftAddressVaultKeyring({
    keyringValue: JSON.stringify({ '2026-01': reusedKey, '2026-02': reusedKey }),
    activeKeyVersion: '2026-02'
  }), null);
});

test('gift consent withdrawal deletes only the recipient-scoped encrypted address and audits revocation', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('DELETE FROM gift_address_vault_entries')) {
        return { rowCount: 1, rows: [{ vault_ref: 'vault-ref' }] };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  const result = await revokeGiftAddressVaultEntry(client, {
    orderId: 'order-1',
    recipientUserId: 'recipient-1',
    actorUserId: 'recipient-1'
  });
  assert.deepEqual(result, { revoked: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /WHERE order_id = \$1 AND recipient_user_id = \$2/);
  assert.deepEqual(calls[0].params, ['order-1', 'recipient-1']);
  assert.match(calls[1].sql, /action\)\s*VALUES \(\$1, \$2, 'revoked'\)/);
  assert.deepEqual(calls[1].params, ['order-1', 'recipient-1']);
  assert.doesNotMatch(JSON.stringify(calls), /addressLine1|deliveryInstructions|phone|postalCode/);
});

test('gift consent withdrawal remains idempotent when no encrypted address row exists', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    }
  };
  const result = await revokeGiftAddressVaultEntry(client, {
    orderId: 'order-2',
    recipientUserId: 'recipient-2',
    actorUserId: 'recipient-2'
  });
  assert.deepEqual(result, { revoked: false });
  assert.equal(calls.length, 1, 'no synthetic audit event is written when there was no vault row');
});

test('gift address vault revocation rejects incomplete actor context before querying', async () => {
  let queried = false;
  await assert.rejects(
    revokeGiftAddressVaultEntry({ query: async () => { queried = true; } }, {
      orderId: 'order-3',
      recipientUserId: 'recipient-3'
    }),
    /gift address revocation context is required/
  );
  assert.equal(queried, false);
});
