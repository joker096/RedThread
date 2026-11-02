/**
 * Create an API-compatible UUID for ad-event idempotency.
 * The fallback keeps the server's UUID validation contract even in browsers
 * without crypto.randomUUID; the ID is not an authorization credential.
 */
export function createAdEventId(): string {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
  try {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  } catch {
    // Fall through to getRandomValues or the compatibility fallback.
  }

  const bytes = new Uint8Array(16);
  try {
    if (typeof cryptoApi?.getRandomValues === 'function') {
      cryptoApi.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
  } catch {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
