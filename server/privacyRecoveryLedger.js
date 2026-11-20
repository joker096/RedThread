import { createHmac, randomUUID } from 'node:crypto';

export const PRIVACY_RECOVERY_EVENT_TYPES = Object.freeze([
  'account_erasure_requested',
  'voice_intro_consent_withdrawn',
  'voice_intro_erasure_requested',
  'private_photo_erasure_requested',
  'identity_l3_consent_withdrawn',
  'ad_consent_revoked',
  'gift_order_consent_withdrawn',
  'gift_address_draft_consent_withdrawn'
]);

const ALLOWED_EVENT_TYPES = new Set(PRIVACY_RECOVERY_EVENT_TYPES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hmacHex(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function ledgerIsRequired(env) {
  return env.PRIVACY_RECOVERY_LEDGER_REQUIRED === 'true' || env.NODE_ENV === 'production';
}

function validateEndpoint(endpoint, env = process.env) {
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error('privacy_recovery_ledger_invalid_url');
  }
  const testLoopbackHttp = env.NODE_ENV === 'test' && parsedEndpoint.protocol === 'http:' &&
    parsedEndpoint.hostname === '127.0.0.1';
  if ((parsedEndpoint.protocol !== 'https:' && !testLoopbackHttp) || parsedEndpoint.pathname !== '/' ||
      parsedEndpoint.search || parsedEndpoint.hash || parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error('privacy_recovery_ledger_invalid_url');
  }
  return parsedEndpoint;
}

export function createPrivacyRecoveryLedgerPayload({
  eventType, userId, resourceId = null, occurredAt = new Date().toISOString(), eventId = randomUUID()
}, { env = process.env } = {}) {
  if (!ALLOWED_EVENT_TYPES.has(eventType) || typeof userId !== 'string' || !userId ||
      (eventType === 'gift_address_draft_consent_withdrawn' && (typeof resourceId !== 'string' || !resourceId)) ||
      (resourceId !== null && (typeof resourceId !== 'string' || !resourceId)) ||
      !UUID.test(eventId) || !Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError('invalid_privacy_recovery_event');
  }

  const endpoint = env.PRIVACY_RECOVERY_LEDGER_URL;
  const authSecret = env.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET;
  const pseudonymKey = env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY;
  if (!endpoint || !authSecret || !pseudonymKey) {
    if (!ledgerIsRequired(env)) return { skipped: true };
    throw new Error('privacy_recovery_ledger_not_configured');
  }
  if (authSecret.length < 32 || pseudonymKey.length < 32) {
    throw new Error('privacy_recovery_ledger_not_configured');
  }

  return {
    event_id: eventId,
    schema_version: 1,
    event_type: eventType,
    subject_ref: hmacHex(pseudonymKey, userId),
    ...(resourceId ? { resource_ref: hmacHex(pseudonymKey, resourceId) } : {}),
    occurred_at: new Date(occurredAt).toISOString()
  };
}

export async function deliverPrivacyRecoveryLedgerPayload(event, {
  env = process.env, fetchImpl = globalThis.fetch, now = Date.now
} = {}) {
  if (!event || !UUID.test(event.event_id || '') || event.schema_version !== 1 ||
      !ALLOWED_EVENT_TYPES.has(event.event_type) ||
      (event.event_type === 'gift_address_draft_consent_withdrawn' && typeof event.resource_ref !== 'string') ||
      !/^[a-f0-9]{64}$/i.test(event.subject_ref || '') ||
      (event.resource_ref != null && !/^[a-f0-9]{64}$/i.test(event.resource_ref)) ||
      !Number.isFinite(Date.parse(event.occurred_at)) ||
      new Date(event.occurred_at).toISOString() !== event.occurred_at) {
    throw new TypeError('invalid_privacy_recovery_event_payload');
  }
  const endpoint = env.PRIVACY_RECOVERY_LEDGER_URL;
  const authSecret = env.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET;
  if (!endpoint || !authSecret || authSecret.length < 32) {
    if (!ledgerIsRequired(env)) return { skipped: true };
    throw new Error('privacy_recovery_ledger_not_configured');
  }
  if (typeof fetchImpl !== 'function') throw new Error('privacy_recovery_ledger_not_configured');
  const parsedEndpoint = validateEndpoint(endpoint, env);
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(now() / 1000));
  const signature = hmacHex(authSecret, `${timestamp}.${body}`);

  let response;
  try {
    response = await fetchImpl(new URL('/v1/events', parsedEndpoint).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ledger-timestamp': timestamp,
        'x-ledger-signature': signature
      },
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw new Error('privacy_recovery_ledger_unavailable');
  }
  if (!response?.ok) throw new Error('privacy_recovery_ledger_rejected_event');
  let acknowledgement;
  try {
    acknowledgement = await response.json();
  } catch {
    throw new Error('privacy_recovery_ledger_invalid_acknowledgement');
  }
  if (acknowledgement?.accepted !== true ||
      acknowledgement.event_id !== event.event_id ||
      !Number.isSafeInteger(acknowledgement.sequence) || acknowledgement.sequence < 1) {
    throw new Error('privacy_recovery_ledger_invalid_acknowledgement');
  }
  return { acknowledged: true, sequence: acknowledgement.sequence, eventId: acknowledgement.event_id };
}

export async function appendPrivacyRecoveryEvent(input, options = {}) {
  const event = createPrivacyRecoveryLedgerPayload(input, options);
  if (event.skipped) return event;
  return deliverPrivacyRecoveryLedgerPayload(event, options);
}
