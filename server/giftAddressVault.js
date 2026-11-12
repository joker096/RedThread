import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ADDRESS_FIELDS = Object.freeze([
  'recipientName',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'countryCode',
  'deliveryInstructions'
]);
const VAULT_AAD_PREFIX = 'vow-gift-address:v1';

export function parseGiftAddressVaultKey(value = process.env.GIFT_ADDRESS_VAULT_KEY) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 && key.toString('base64') === value ? key : null;
}

export function normalizeGiftAddress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_address' };
  }
  if (Object.keys(input).some(field => !ADDRESS_FIELDS.includes(field))) {
    return { ok: false, error: 'unknown_address_field' };
  }
  const address = {};
  for (const field of ADDRESS_FIELDS) {
    const value = input[field];
    if (value == null && ['addressLine2', 'region', 'postalCode', 'deliveryInstructions'].includes(field)) continue;
    if (typeof value !== 'string') return { ok: false, error: 'invalid_address' };
    const trimmed = value.trim();
    const max = field === 'deliveryInstructions' ? 300 : field === 'addressLine1' ? 200 : 120;
    if (!trimmed || trimmed.length > max) {
      if (field === 'addressLine2' || field === 'region' || field === 'postalCode' || field === 'deliveryInstructions') continue;
      return { ok: false, error: 'invalid_address' };
    }
    address[field] = trimmed;
  }
  if (!/^[A-Z]{2}$/.test(address.countryCode || '')) return { ok: false, error: 'invalid_country_code' };
  if (!/^\+?[0-9 ()-]{7,24}$/.test(address.phone || '')) return { ok: false, error: 'invalid_phone' };
  return { ok: true, address };
}

function associatedData(orderId, recipientUserId) {
  if (typeof orderId !== 'string' || !orderId || typeof recipientUserId !== 'string' || !recipientUserId) {
    throw new TypeError('order and recipient identifiers are required');
  }
  return Buffer.from(`${VAULT_AAD_PREFIX}:${orderId}:${recipientUserId}`, 'utf8');
}

export function encryptGiftAddress({ address, orderId, recipientUserId, key, keyVersion = 'v1' } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('a 32-byte vault key is required');
  if (typeof keyVersion !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(keyVersion)) {
    throw new TypeError('invalid vault key version');
  }
  const normalized = normalizeGiftAddress(address);
  if (!normalized.ok) throw new TypeError(normalized.error);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(orderId, recipientUserId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(normalized.address), 'utf8'),
    cipher.final()
  ]);
  return {
    nonce,
    authTag: cipher.getAuthTag(),
    ciphertext,
    keyVersion
  };
}

export function decryptGiftAddress({ encrypted, orderId, recipientUserId, key } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('a 32-byte vault key is required');
  if (!encrypted || !Buffer.isBuffer(encrypted.nonce) || encrypted.nonce.length !== 12 ||
      !Buffer.isBuffer(encrypted.authTag) || encrypted.authTag.length !== 16 ||
      !Buffer.isBuffer(encrypted.ciphertext) || encrypted.ciphertext.length === 0) {
    throw new TypeError('invalid encrypted vault record');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce);
  decipher.setAAD(associatedData(orderId, recipientUserId));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final()
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  const normalized = normalizeGiftAddress(parsed);
  if (!normalized.ok) throw new Error('decrypted_gift_address_invalid');
  return normalized.address;
}
