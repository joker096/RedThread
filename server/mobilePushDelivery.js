import { createSign } from 'node:crypto';
import http2 from 'node:http2';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_TOKEN_TTL_MS = 50 * 60 * 1000;
const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
let fcmAccessTokenCache = null;
const apnsProviderTokenCache = new Map();

function base64Url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function normalizePrivateKey(value) {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '';
}

export function createFcmServiceAssertion({ clientEmail, privateKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) throw new TypeError('invalid_fcm_client_email');
  const key = normalizePrivateKey(privateKey);
  if (!key.includes('PRIVATE KEY')) throw new TypeError('invalid_fcm_private_key');
  const header = base64Url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64Url({
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: FCM_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  });
  const signingInput = header + '.' + payload;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return signingInput + '.' + signer.sign(key).toString('base64url');
}

export function createApnsProviderToken({ teamId, keyId, privateKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!/^[A-Z0-9]{10}$/.test(String(teamId || '')) || !/^[A-Z0-9]{10}$/.test(String(keyId || ''))) {
    throw new TypeError('invalid_apns_provider_identity');
  }
  const key = normalizePrivateKey(privateKey);
  if (!key.includes('PRIVATE KEY')) throw new TypeError('invalid_apns_private_key');
  const header = base64Url({ alg: 'ES256', kid: keyId });
  const payload = base64Url({ iss: teamId, iat: nowSeconds });
  const signingInput = header + '.' + payload;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return signingInput + '.' + signature;
}

export function mobilePushRetryDelayMs(attemptCount) {
  const attempts = Number(attemptCount);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new RangeError('push attempt count must be an integer between 1 and 100');
  }
  return Math.min(MAX_RETRY_DELAY_MS, 30_000 * (2 ** Math.min(attempts - 1, 16)));
}

export function classifyFcmResponse(status, payload = {}) {
  const error = payload?.error || {};
  const errorCode = Array.isArray(error.details)
    ? error.details.find(item => item?.errorCode)?.errorCode
    : null;
  if (status >= 200 && status < 300 && typeof payload?.name === 'string') {
    return { outcome: 'sent', providerMessageId: payload.name };
  }
  if (status === 404 || errorCode === 'UNREGISTERED') return { outcome: 'invalid_token', errorCode: 'unregistered' };
  if (status === 429 || status >= 500 || status === 401 || status === 403) {
    return { outcome: 'retry', errorCode: status === 401 || status === 403 ? 'provider_auth_failed' : 'provider_unavailable' };
  }
  return { outcome: 'failed', errorCode: 'provider_rejected_payload' };
}

export function classifyApnsResponse(status, payload = {}) {
  const reason = typeof payload?.reason === 'string' ? payload.reason : '';
  if (status === 200) return { outcome: 'sent', providerMessageId: null };
  if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken') {
    return { outcome: 'invalid_token', errorCode: 'unregistered' };
  }
  if (status === 429 || status >= 500 || status === 401 || status === 403) {
    return { outcome: 'retry', errorCode: status === 401 || status === 403 ? 'provider_auth_failed' : 'provider_unavailable' };
  }
  return { outcome: 'failed', errorCode: 'provider_rejected_payload' };
}

export function buildFcmMessage(token, payload, collapseId = undefined) {
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data: { type: payload.data.type, route: payload.data.route },
      android: { priority: 'HIGH', ...(collapseId ? { collapse_key: collapseId } : {}), notification: { channel_id: 'vow_messages' } }
    }
  };
}

export function buildApnsPayload(payload) {
  return {
    aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' },
    type: payload.data.type,
    route: payload.data.route
  };
}

async function getFcmAccessToken(config, fetchImpl) {
  const now = Date.now();
  if (fcmAccessTokenCache && fcmAccessTokenCache.expiresAt > now + 30_000) {
    return fcmAccessTokenCache.value;
  }
  const assertion = createFcmServiceAssertion({
    clientEmail: config.clientEmail,
    privateKey: config.privateKey
  });
  const response = await fetchImpl(FCM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.access_token !== 'string' ||
      !Number.isFinite(Number(data.expires_in))) {
    throw new Error('fcm_oauth_token_unavailable');
  }
  fcmAccessTokenCache = {
    value: data.access_token,
    expiresAt: now + Math.max(60, Number(data.expires_in)) * 1000
  };
  return fcmAccessTokenCache.value;
}

async function sendApnsRequest({ host, token, topic, providerToken, payload, collapseId, http2Module = http2 }) {
  return new Promise((resolve, reject) => {
    const client = http2Module.connect(host);
    let status = 0;
    let body = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };
    client.once('error', () => finish(new Error('apns_transport_unavailable')));
    if (typeof client.setTimeout === 'function') client.setTimeout(15_000, () => finish(new Error('apns_transport_timeout')));
    const request = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + encodeURIComponent(token),
      authorization: 'bearer ' + providerToken,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      ...(collapseId ? { 'apns-collapse-id': collapseId.slice(0, 64) } : {}),
      'content-type': 'application/json'
    });
    request.on('response', headers => { status = Number(headers[':status']) || 0; });
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.once('error', () => finish(new Error('apns_transport_unavailable')));
    request.once('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}
      finish(null, { status, payload: parsed });
    });
    request.end(JSON.stringify(buildApnsPayload(payload)));
  });
}

export async function sendMobilePush({ platform, token, payload, collapseId, env = process.env, fetchImpl = fetch, http2Module = http2 }) {
  if (platform === 'android') {
    const projectId = (env.FIREBASE_PROJECT_ID || '').trim();
    const clientEmail = (env.FIREBASE_CLIENT_EMAIL || '').trim();
    const privateKey = normalizePrivateKey(env.FIREBASE_PRIVATE_KEY);
    if (!projectId || !clientEmail || !privateKey.includes('PRIVATE KEY')) throw new Error('fcm_provider_not_configured');
    const accessToken = await getFcmAccessToken({ clientEmail, privateKey }, fetchImpl);
    const response = await fetchImpl(
      'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/messages:send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFcmMessage(token, payload, collapseId)),
        signal: AbortSignal.timeout(15_000)
      }
    );
    const data = await response.json().catch(() => ({}));
    return classifyFcmResponse(response.status, data);
  }
  if (platform === 'ios') {
    const teamId = (env.APNS_TEAM_ID || '').trim();
    const keyId = (env.APNS_KEY_ID || '').trim();
    const privateKey = normalizePrivateKey(env.APNS_PRIVATE_KEY);
    const topic = (env.IOS_BUNDLE_ID || '').trim();
    const environment = (env.APNS_ENVIRONMENT || '').trim();
    if (!teamId || !keyId || !topic || !privateKey.includes('PRIVATE KEY') ||
        !['sandbox', 'production'].includes(environment)) throw new Error('apns_provider_not_configured');
    const cacheKey = teamId + ':' + keyId;
    const cached = apnsProviderTokenCache.get(cacheKey);
    const now = Date.now();
    const providerToken = cached && cached.expiresAt > now + 30_000
      ? cached.value
      : createApnsProviderToken({ teamId, keyId, privateKey });
    if (!cached || cached.expiresAt <= now + 30_000) {
      apnsProviderTokenCache.set(cacheKey, { value: providerToken, expiresAt: now + APNS_TOKEN_TTL_MS });
    }
    const host = environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const response = await sendApnsRequest({ host, token, topic, providerToken, payload, collapseId, http2Module });
    return classifyApnsResponse(response.status, response.payload);
  }
  throw new Error('unsupported_mobile_push_platform');
}
