import { createHmac, randomUUID } from 'node:crypto';

const ALLOWED_EVENT_TYPES = new Set([
  'account_erasure_requested',
  'voice_intro_consent_withdrawn',
  'identity_l3_consent_withdrawn',
  'ad_consent_revoked',
  'gift_order_consent_withdrawn'
]);

function hmacHex(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function ledgerIsRequired(env) {
  return env.PRIVACY_RECOVERY_LEDGER_REQUIRED === 'true' || env.NODE_ENV === 'production';
}

export async function appendPrivacyRecoveryEvent({
  eventType,
  userId,
  resourceId = null,
  occurredAt = new Date().toISOString()
}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  if (!ALLOWED_EVENT_TYPES.has(eventType) || typeof userId !== 'string' || !userId) {
    throw new TypeError('invalid_privacy_recovery_event');
  }

  const endpoint = env.PRIVACY_RECOVERY_LEDGER_URL;
  const authSecret = env.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET;
  const pseudonymKey = env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY;
  if (!endpoint || !authSecret || !pseudonymKey) {
    if (!ledgerIsRequired(env)) return { skipped: true };
    throw new Error('privacy_recovery_ledger_not_configured');
  }
  if (typeof fetchImpl !== 'function' || authSecret.length < 32 || pseudonymKey.length < 32) {
    throw new Error('privacy_recovery_ledger_not_configured');
  }

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error('privacy_recovery_ledger_invalid_url');
  }
  if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.pathname !== '/' ||
      parsedEndpoint.search || parsedEndpoint.hash || parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error('privacy_recovery_ledger_invalid_url');
  }

  const event = {
    event_id: randomUUID(),
    schema_version: 1,
    event_type: eventType,
    subject_ref: hmacHex(pseudonymKey, userId),
    ...(resourceId ? { resource_ref: hmacHex(pseudonymKey, resourceId) } : {}),
    occurred_at: occurredAt
  };
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
      cache: 'no-store'
    });
  } catch {
    throw new Error('privacy_recovery_ledger_unavailable');
  }
  if (!response?.ok) {
    throw new Error('privacy_recovery_ledger_rejected_event');
  }
  let acknowledgement;
  try {
    acknowledgement = await response.json();
  } catch {
    throw new Error('privacy_recovery_ledger_invalid_acknowledgement');
  }
  if (acknowledgement?.accepted !== true ||
      !Number.isSafeInteger(acknowledgement.sequence) || acknowledgement.sequence < 1) {
    throw new Error('privacy_recovery_ledger_invalid_acknowledgement');
  }
  return { acknowledged: true, sequence: acknowledgement.sequence, eventId: event.event_id };
}
