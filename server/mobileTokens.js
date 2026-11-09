import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^vow_(access|refresh)_([A-Za-z0-9_-]{43})$/;

export function createMobileToken(kind) {
  if (kind !== 'access' && kind !== 'refresh') {
    throw new TypeError('Unsupported mobile token kind');
  }
  return `vow_${kind}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashMobileToken(token, expectedKind) {
  if (typeof token !== 'string' || !['access', 'refresh'].includes(expectedKind)) {
    return null;
  }
  const match = TOKEN_PATTERN.exec(token);
  if (!match || match[1] !== expectedKind) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readMobileBearerToken(header) {
  if (typeof header !== 'string' || header.length > 300) return null;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match || !/^vow_access_[A-Za-z0-9_-]{43}$/.test(match[1])) return null;
  return match[1];
}

export function validateMobileDevice(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { platform, deviceId, deviceName } = input;
  if (platform !== 'android' && platform !== 'ios') return null;
  if (typeof deviceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    return null;
  }
  if (typeof deviceName !== 'string') return null;
  const normalizedName = deviceName.trim();
  if (normalizedName.length < 1 || normalizedName.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(normalizedName)) {
    return null;
  }
  return { platform, deviceId: deviceId.toLowerCase(), deviceName: normalizedName };
}
