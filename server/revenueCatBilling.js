const REVENUECAT_EVENT_TYPES = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'CANCELLATION', 'UNCANCELLATION',
  'NON_RENEWING_PURCHASE', 'EXPIRATION', 'BILLING_ISSUE', 'PRODUCT_CHANGE',
  'SUBSCRIPTION_PAUSED', 'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED', 'REFUND_ISSUED', 'TRANSFER'
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRevenueCatEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const event = payload.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') return null;
  if (!REVENUECAT_EVENT_TYPES.has(event.type)) return null;
  if (typeof event.app_user_id !== 'string' || !UUID_PATTERN.test(event.app_user_id)) return null;
  if (!Number.isSafeInteger(event.event_timestamp_ms) || event.event_timestamp_ms < 0) return null;
  return {
    eventId: event.id,
    eventType: event.type,
    appUserId: event.app_user_id,
    occurredAtMs: event.event_timestamp_ms,
    environment: typeof event.environment === 'string' ? event.environment.toUpperCase() : null
  };
}

export function revenueCatEntitlementState(subscriber, entitlementId, now = Date.now()) {
  const entitlement = subscriber?.entitlements?.[entitlementId];
  if (!entitlement || typeof entitlement !== 'object') return { active: false, lifetime: false, expiresAt: null };
  const expiration = entitlement.expires_date == null ? null : Date.parse(entitlement.expires_date);
  const graceExpiration = entitlement.grace_period_expires_date == null
    ? null : Date.parse(entitlement.grace_period_expires_date);
  const activeUntil = Math.max(Number.isFinite(expiration) ? expiration : 0, Number.isFinite(graceExpiration) ? graceExpiration : 0);
  const lifetime = entitlement.expires_date == null && entitlement.grace_period_expires_date == null;
  const active = lifetime || activeUntil > now;
  return { active, lifetime: active && lifetime, expiresAt: active && !lifetime ? new Date(activeUntil).toISOString() : null };
}

export async function fetchRevenueCatSubscriber(appUserId, apiKey) {
  const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.subscriber || typeof payload.subscriber !== 'object') {
    throw new Error('revenuecat_subscriber_lookup_failed');
  }
  return payload.subscriber;
}

export async function processRevenueCatEvent(pool, event, entitlementState) {
  if (!event || !REVENUECAT_EVENT_TYPES.has(event.eventType)) return { duplicate: false, handled: false };
  if (!event.appUserId || !UUID_PATTERN.test(event.appUserId)) throw new Error('invalid_revenuecat_app_user_id');
  if (!Number.isSafeInteger(event.occurredAtMs) || event.occurredAtMs < 0) throw new Error('invalid_revenuecat_event_timestamp');
  if (!entitlementState || typeof entitlementState.active !== 'boolean' || typeof entitlementState.lifetime !== 'boolean'
    || !(entitlementState.expiresAt === null || typeof entitlementState.expiresAt === 'string')) {
    throw new Error('invalid_revenuecat_entitlement_state');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO revenuecat_webhook_events (event_id, event_type, environment) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
      [event.eventId, event.eventType, event.environment]
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true, handled: false };
    }
    const updated = await client.query(
      `UPDATE users SET
         revenuecat_premium_until = $2::timestamptz,
         revenuecat_premium_lifetime = $3::boolean,
         revenuecat_updated_at = TO_TIMESTAMP($4::double precision / 1000),
         updated_at = NOW()
       WHERE id = $1::uuid
         AND (revenuecat_updated_at IS NULL OR revenuecat_updated_at <= TO_TIMESTAMP($4::double precision / 1000))`,
      [event.appUserId, entitlementState.active ? entitlementState.expiresAt : null,
        entitlementState.active && entitlementState.lifetime, event.occurredAtMs]
    );
    await client.query('COMMIT');
    return { duplicate: false, handled: updated.rowCount > 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
