import { createHash } from 'node:crypto';

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,119}$/;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function createGiftProviderWebhookHandler({ pool, providers = {} }) {
  return async function giftProviderWebhookHandler(req, res) {
    const providerKey = req.params?.providerKey;
    const provider = typeof providerKey === 'string' && PROVIDER_KEY_PATTERN.test(providerKey)
      ? providers[providerKey]
      : null;

    // Gift webhooks are sandbox-only. No verifier/account is configured by default.
    if (!provider || typeof provider.verifyWebhook !== 'function'
        || !provider.accountId || provider.environment !== 'sandbox' || !pool?.query) {
      return res.status(503).json({ error: 'gift_provider_webhook_not_configured' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > 256 * 1024) {
      return res.status(400).json({ error: 'invalid_gift_provider_webhook_body' });
    }

    let verified;
    try {
      verified = await provider.verifyWebhook({
        rawBody: req.body,
        headers: req.headers,
        receivedAt: new Date()
      });
    } catch {
      return res.status(401).json({ error: 'invalid_gift_provider_webhook_signature' });
    }

    if (!verified || verified.providerAccountId !== provider.accountId
        || verified.environment !== provider.environment
        || typeof verified.eventId !== 'string' || !EVENT_ID_PATTERN.test(verified.eventId)
        || typeof verified.eventType !== 'string' || !EVENT_TYPE_PATTERN.test(verified.eventType)) {
      return res.status(401).json({ error: 'untrusted_gift_provider_webhook_event' });
    }

    if (typeof verified.providerReference !== 'string'
        || !PROVIDER_REFERENCE_PATTERN.test(verified.providerReference)
        || !Number.isSafeInteger(verified.amountMinorUnits) || verified.amountMinorUnits <= 0
        || typeof verified.currency !== 'string' || !CURRENCY_PATTERN.test(verified.currency)) {
      return res.status(400).json({ error: 'invalid_gift_provider_payment_metadata' });
    }

    let occurredAt = null;
    if (verified.occurredAt !== undefined && verified.occurredAt !== null) {
      const parsed = verified.occurredAt instanceof Date
        ? verified.occurredAt
        : new Date(verified.occurredAt);
      if (!Number.isFinite(parsed.getTime())) {
        return res.status(400).json({ error: 'invalid_gift_provider_event_timestamp' });
      }
      occurredAt = parsed.toISOString();
    }

    const payloadHash = createHash('sha256').update(req.body).digest('hex');
    try {
      const result = await pool.query(
        'SELECT record_verified_gift_provider_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
        [
          providerKey, verified.eventId, verified.eventType, payloadHash, occurredAt,
          verified.providerAccountId, verified.environment, verified.providerReference,
          verified.amountMinorUnits, verified.currency
        ]
      );
      const status = result.rows?.[0]?.result;
      if (!['inserted', 'duplicate', 'conflict'].includes(status)) {
        return res.status(500).json({ error: 'gift_provider_event_inbox_failed' });
      }
      // Only verified routing metadata and a hash are persisted, never raw payload.
      // A separate fenced processor matches the immutable attempt and wakes existing work.
      return res.status(status === 'conflict' ? 202 : 200).json({
        received: true,
        duplicate: status === 'duplicate',
        quarantined: status === 'conflict'
      });
    } catch {
      return res.status(500).json({ error: 'gift_provider_event_inbox_failed' });
    }
  };
}
