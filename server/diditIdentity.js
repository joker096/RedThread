import { createHmac, timingSafeEqual } from 'node:crypto';
const DIDIT_API_BASE = 'https://verification.didit.me';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIDIT_STATUSES = new Set(['Not Started', 'In Progress', 'Approved', 'Declined', 'In Review', 'Awaiting User', 'Resubmitted', 'Expired', 'Abandoned', 'Kyc Expired']);
export function isDiditConfigured(env = process.env) {
  return env.DIDIT_ENVIRONMENT === 'sandbox' && env.DIDIT_SANDBOX_KEY_CONFIRMED === 'true' && Boolean(env.DIDIT_API_KEY) &&
    UUID_PATTERN.test(env.DIDIT_WORKFLOW_ID || '') && UUID_PATTERN.test(env.DIDIT_APPLICATION_ID || '') && Boolean(env.DIDIT_WEBHOOK_SECRET);
}
function serializeCanonicalValue(value) {
  if (Array.isArray(value)) return '[' + value.map(serializeCanonicalValue).join(',') + ']';
  if (value && typeof value === 'object') {
    // Serialize sorted entries directly. Rebuilding an object can reorder
    // integer-like keys numerically before JSON.stringify sees them.
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + serializeCanonicalValue(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

export function canonicalizeDiditPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('invalid_didit_webhook_payload');
  return serializeCanonicalValue(payload);
}

function safeHexEqual(expectedHex, receivedHex) {
  if (typeof receivedHex !== 'string' || !/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex'), received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
export function verifyDiditWebhook({ payload, signature, timestampHeader, secret, previousSignature, previousSecret, now = Date.now }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !secret ||
      typeof timestampHeader !== 'string' || !/^\d{10}$/.test(timestampHeader) ||
      !Number.isSafeInteger(payload.timestamp) || String(payload.timestamp) !== timestampHeader) return false;
  if (Math.abs(Math.floor(now() / 1000) - Number(timestampHeader)) > 300) return false;
  let canonical;
  try { canonical = canonicalizeDiditPayload(payload); } catch { return false; }
  const verify = (key, digest) => {
    if (!key || !digest) return false;
    return safeHexEqual(createHmac('sha256', key).update(canonical, 'utf8').digest('hex'), digest);
  };
  return verify(secret, signature) || verify(previousSecret, previousSignature);
}
export function projectDiditStatus(status) { return DIDIT_STATUSES.has(status) ? 'pending' : null; }
export function isDiditStatus(value) { return DIDIT_STATUSES.has(value); }
export function isDiditUuid(value) { return typeof value === 'string' && UUID_PATTERN.test(value); }
export async function createDiditSession({ userId, env = process.env, fetchImpl = fetch, callbackOrigin = env.APP_ORIGIN || 'http://localhost:3000' }) {
  if (!isDiditConfigured(env)) throw new Error('didit_sandbox_not_configured');
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) throw new TypeError('invalid_didit_user_id');
  let callback;
  try {
    const origin = new URL(callbackOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) || origin.username || origin.password) throw new Error('invalid_origin');
    callback = new URL('/?identityVerification=return', origin.origin).toString();
  } catch { throw new TypeError('invalid_didit_callback_origin'); }
  const body = JSON.stringify({ workflow_id: env.DIDIT_WORKFLOW_ID, vendor_data: userId, callback, language: 'ru' });
  let response;
  try {
    response = await fetchImpl(DIDIT_API_BASE + '/v3/session/', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'x-api-key': env.DIDIT_API_KEY, 'Content-Type': 'application/json' }, body
    });
  } catch { throw new Error('didit_session_request_failed'); }
  if (!response.ok) throw new Error('didit_session_request_failed');
  let result;
  try { result = await response.json(); } catch { throw new Error('didit_session_response_invalid'); }
  if (typeof result?.session_id !== 'string' || !UUID_PATTERN.test(result.session_id) || result.workflow_id !== env.DIDIT_WORKFLOW_ID || typeof result.url !== 'string') throw new Error('didit_session_response_invalid');
  let url;
  try {
    url = new URL(result.url);
    if (url.protocol !== 'https:' || url.hostname !== 'verify.didit.me' || url.username || url.password || url.port) throw new Error('bad_url');
  } catch { throw new Error('didit_session_response_invalid'); }
  return { sessionId: result.session_id, verificationUrl: url.toString(), providerStatus: DIDIT_STATUSES.has(result.status) ? result.status : 'Not Started' };
}
