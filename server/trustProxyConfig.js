/**
 * Parse an explicit, bounded proxy hop count for Express.
 * Undefined/empty means direct access with no trusted proxy.
 */
export function resolveTrustProxyHops(value) {
  if (value === undefined || value === null || value === '') return 0;
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new TypeError('invalid_trust_proxy_hops');
  }
  const hops = Number(text);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 5) {
    throw new RangeError('invalid_trust_proxy_hops');
  }
  return hops;
}
