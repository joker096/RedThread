import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('VOWPUSH1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseMobilePushTokenEncryptionKey(value = process.env.MOBILE_PUSH_TOKEN_ENCRYPTION_KEY) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}

export function validateMobilePushToken(token, platform) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return false;
  if (platform === 'android') return token.includes(':') && /^[A-Za-z0-9:_\-.]+$/.test(token);
  if (platform === 'ios') return /^[a-f0-9]{64}$/i.test(token);
  return false;
}

export function fingerprintMobilePushToken(token, key) {
  if (!validateMobilePushToken(token, 'android') && !validateMobilePushToken(token, 'ios')) {
    throw new TypeError('invalid_mobile_push_token');
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('invalid_mobile_push_token_encryption_key');
  return createHmac('sha256', key).update(token, 'utf8').digest('hex');
}

export function encryptMobilePushToken(token, key) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new TypeError('invalid_mobile_push_token');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('invalid_mobile_push_token_encryption_key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptMobilePushToken(value, key) {
  if (!Buffer.isBuffer(value) || value.length <= MAGIC.length + IV_BYTES + TAG_BYTES ||
      !value.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('invalid_mobile_push_token_ciphertext');
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('invalid_mobile_push_token_encryption_key');
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const bodyStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(ivStart, tagStart));
  decipher.setAuthTag(value.subarray(tagStart, bodyStart));
  try {
    return Buffer.concat([decipher.update(value.subarray(bodyStart)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('mobile_push_token_authentication_failed');
  }
}

const PUSH_MESSAGES = Object.freeze({
  new_match: Object.freeze({ title: 'Vow', body: 'You have a new mutual match.', route: '/chats' }),
  new_message: Object.freeze({ title: 'Vow', body: 'You have a new message.', route: '/chats' }),
  gift_request: Object.freeze({ title: 'Vow', body: 'You have a gift request to review.', route: '/gifts' }),
  gift_request_update: Object.freeze({ title: 'Vow', body: 'There is an update to your gift request.', route: '/gifts' })
});

export function safeMobilePushPayload(type) {
  const payload = PUSH_MESSAGES[type];
  if (!payload) return null;
  return { ...payload, data: { type, route: payload.route } };
}
