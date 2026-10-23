import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(derivedKey).toString('hex')}`;
}

export async function verifyPassword(password, encodedHash) {
  if (typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) {
    return false;
  }

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derivedKey = Buffer.from(await scrypt(password, salt, expected.length));
  return expected.length === derivedKey.length && timingSafeEqual(expected, derivedKey);
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLocaleLowerCase('en-US');
}

export function isValidEmail(email) {
  if (typeof email !== 'string' || email.length > 254) return false;

  const separator = email.indexOf('@');
  if (separator <= 0 || separator !== email.lastIndexOf('@')) return false;

  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (local.length > 64 || domain.length > 253 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return false;
  }

  // Accept dot-atom addresses while rejecting whitespace, controls and malformed separators.
  if (!/^[^\s@<>()[\]\\,;:"]+(?:\.[^\s@<>()[\]\\,;:"]+)*$/u.test(local)) return false;

  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label =>
    label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-') ||
    !/^[\p{L}\p{N}-]+$/u.test(label)
  )) return false;

  const topLevelDomain = labels[labels.length - 1];
  return [...topLevelDomain].length >= 2 && /[\p{L}]/u.test(topLevelDomain);
}

export function isAdultDate(value, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;

  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  return parsed <= cutoff;
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
