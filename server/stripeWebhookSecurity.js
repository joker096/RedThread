import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyStripeWebhookSignature(body, header, secret, now = Date.now()) {
  if (!Buffer.isBuffer(body) || typeof header !== 'string' || !secret) return false;
  const timestamp = header.match(/(?:^|,)\s*t=(\d+)/)?.[1];
  const signatures = [...header.matchAll(/(?:^|,)\s*v1=([a-f0-9]{64})/gi)].map(match => match[1]);
  if (!timestamp || !signatures.length) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > 5 * 60 * 1000) return false;
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(body).digest();
  return signatures.some(signature => {
    const supplied = Buffer.from(signature, 'hex');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
