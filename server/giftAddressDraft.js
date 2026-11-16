import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { normalizeGiftAddress } from './giftAddressVault.js';

const AAD_PREFIX = 'vow-gift-address-draft:v1';
export const GIFT_ADDRESS_DRAFT_CONSENT_VERSION = 1;
export const GIFT_ADDRESS_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const GIFT_ADDRESS_DRAFT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export function parseGiftAddressDraftKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 && key.toString('base64') === value ? key : null;
}

export function parseGiftAddressDraftKeyring({
  keyringValue = process.env.GIFT_ADDRESS_DRAFT_KEYRING,
  activeKeyVersion = process.env.GIFT_ADDRESS_DRAFT_ACTIVE_KEY_VERSION
} = {}) {
  if (typeof keyringValue !== 'string' || !keyringValue.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(keyringValue); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (!entries.length || entries.length > 32 ||
      typeof activeKeyVersion !== 'string' ||
      !/^[A-Za-z0-9._-]{1,32}$/.test(activeKeyVersion) ||
      !Object.hasOwn(parsed, activeKeyVersion)) return null;
  const keys = new Map();
  for (const [version, encoded] of entries) {
    const key = parseGiftAddressDraftKey(encoded);
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(version) || !key ||
        [...keys.values()].some(existing => existing.equals(key))) return null;
    keys.set(version, key);
  }
  return { activeKeyVersion, keys };
}

function resolveKey(keyring, version) {
  const key = keyring?.keys instanceof Map ? keyring.keys.get(version) : null;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('gift_address_draft_key_unavailable');
  return key;
}

function aad(orderId, recipientUserId, version) {
  if (typeof orderId !== 'string' || !orderId ||
      typeof recipientUserId !== 'string' || !recipientUserId ||
      typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(version)) {
    throw new TypeError('gift_address_draft_context_invalid');
  }
  return Buffer.from(`${AAD_PREFIX}:${version}:${orderId}:${recipientUserId}`, 'utf8');
}

export function encryptGiftAddressDraft({ address, orderId, recipientUserId, keyring } = {}) {
  if (!keyring || !(keyring.keys instanceof Map) ||
      typeof keyring.activeKeyVersion !== 'string') throw new Error('gift_address_draft_keyring_unavailable');
  const normalized = normalizeGiftAddress(address);
  if (!normalized.ok) throw new TypeError(normalized.error);
  const version = keyring.activeKeyVersion;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', resolveKey(keyring, version), nonce);
  cipher.setAAD(aad(orderId, recipientUserId, version));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized.address), 'utf8'), cipher.final()]);
  return { keyVersion: version, nonce, authTag: cipher.getAuthTag(), ciphertext };
}

export function decryptGiftAddressDraft({ encrypted, orderId, recipientUserId, keyring } = {}) {
  if (!encrypted || !Buffer.isBuffer(encrypted.nonce) || encrypted.nonce.length !== 12 ||
      !Buffer.isBuffer(encrypted.authTag) || encrypted.authTag.length !== 16 ||
      !Buffer.isBuffer(encrypted.ciphertext) || encrypted.ciphertext.length === 0) {
    throw new TypeError('gift_address_draft_ciphertext_invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(keyring, encrypted.keyVersion), encrypted.nonce);
  decipher.setAAD(aad(orderId, recipientUserId, encrypted.keyVersion));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  const normalized = normalizeGiftAddress(parsed);
  if (!normalized.ok) throw new Error('gift_address_draft_plaintext_invalid');
  return normalized.address;
}

export function resolveGiftAddressDraftExpiry({ now = Date.now(), ttlMs = GIFT_ADDRESS_DRAFT_TTL_MS } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > GIFT_ADDRESS_DRAFT_MAX_TTL_MS) {
    throw new RangeError('gift_address_draft_ttl_invalid');
  }
  return new Date(now + ttlMs);
}
