import { createHmac, timingSafeEqual } from 'node:crypto';

const SUMSUB_API_BASE = 'https://api.sumsub.com';
const WEBHOOK_ALGORITHMS = Object.freeze({
  HMAC_SHA256_HEX: 'sha256',
  HMAC_SHA512_HEX: 'sha512'
});

export function isSumsubConfigured(env = process.env) {
  return env.SUMSUB_ENVIRONMENT === 'sandbox' &&
    Boolean(env.SUMSUB_APP_TOKEN) &&
    Boolean(env.SUMSUB_SECRET_KEY) &&
    Boolean(env.SUMSUB_WEBHOOK_SECRET) &&
    Boolean(env.SUMSUB_LEVEL_NAME);
}

export function createSumsubSignature({ secretKey, timestamp, method, path, body = '' }) {
  if (!secretKey || !Number.isInteger(timestamp) || timestamp <= 0 ||
      typeof method !== 'string' || typeof path !== 'string' ||
      !path.startsWith('/') || path.startsWith('//') || typeof body !== 'string') {
    throw new TypeError('invalid_sumsub_signature_input');
  }
  return createHmac('sha256', secretKey)
    .update(String(timestamp) + method.toUpperCase() + path + body, 'utf8')
    .digest('hex');
}

export function verifySumsubWebhook({ rawBody, digest, algorithm, secret }) {
  const digestAlgorithm = WEBHOOK_ALGORITHMS[algorithm];
  if (!Buffer.isBuffer(rawBody) || !digestAlgorithm || typeof digest !== 'string' ||
      !/^[a-f0-9]+$/i.test(digest) || !secret) return false;
  const expected = createHmac(digestAlgorithm, secret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(digest, 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function projectSumsubReview(payload) {
  if (!payload || payload.type !== 'applicantReviewed' || payload.reviewStatus !== 'completed') {
    return 'pending';
  }
  if (payload.reviewResult?.reviewAnswer === 'GREEN') return 'verified';
  if (payload.reviewResult?.reviewAnswer === 'RED') return 'rejected';
  return 'pending';
}

export async function createSumsubAccessToken({ userId, env = process.env, fetchImpl = fetch, now = Date.now }) {
  if (!isSumsubConfigured(env)) throw new Error('sumsub_sandbox_not_configured');
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new TypeError('invalid_sumsub_user_id');
  }
  const query = new URLSearchParams({
    userId,
    levelName: env.SUMSUB_LEVEL_NAME,
    ttlInSecs: '600'
  });
  const requestPath = '/resources/accessTokens?' + query.toString();
  const timestamp = Math.floor(now() / 1000);
  const signature = createSumsubSignature({
    secretKey: env.SUMSUB_SECRET_KEY,
    timestamp,
    method: 'POST',
    path: requestPath
  });
  const response = await fetchImpl(SUMSUB_API_BASE + requestPath, {
    method: 'POST',
    headers: {
      'X-App-Token': env.SUMSUB_APP_TOKEN,
      'X-App-Access-Ts': String(timestamp),
      'X-App-Access-Sig': signature,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) {
    // Do not pass provider response bodies to clients or logs: they may contain PII.
    throw new Error('sumsub_access_token_request_failed');
  }
  const result = await response.json();
  if (typeof result?.token !== 'string' || !result.token.startsWith('_act-')) {
    throw new Error('sumsub_access_token_response_invalid');
  }
  return result.token;
}
