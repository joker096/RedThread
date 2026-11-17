import { createHash, randomUUID } from 'node:crypto';

export const PADDLE_WEBHOOK_LEASE_MS = 5 * 60_000;
export const PADDLE_WEBHOOK_HEARTBEAT_MS = 60_000;
export const PADDLE_WEBHOOK_MAX_ATTEMPTS = 8;

export function paddleWebhookRetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > PADDLE_WEBHOOK_MAX_ATTEMPTS) {
    throw new RangeError('Paddle webhook attempt is outside the supported range');
  }
  return Math.min(60 * 60_000, 5_000 * (2 ** (attempt - 1)));
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'paddle_webhook_processing_failed';
}

export function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('invalid_paddle_event_value');
    return serialized;
  }
  // Paddle SDK timestamps may be hydrated as Date instances. Preserve their
  // JSON wire representation so distinct provider timestamps hash differently.
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('invalid_paddle_event_date');
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => item === undefined ? 'null' : stableJsonStringify(item)).join(',') + ']';
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('unsupported_paddle_event_object');
  }
  return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + stableJsonStringify(value[key])).join(',') + '}';
}

export async function enqueueVerifiedPaddleWebhook(pool, event) {
  const eventId = event?.eventId || event?.event_id;
  const eventType = event?.eventType || event?.event_type;
  const rawOccurredAt = event?.occurredAt || event?.occurred_at || null;
  const occurredAt = typeof rawOccurredAt === 'string' && Number.isFinite(Date.parse(rawOccurredAt))
    ? new Date(rawOccurredAt).toISOString() : null;
  if (typeof eventId !== 'string' || !eventId || eventId.length > 255 ||
      typeof eventType !== 'string' || !eventType || eventType.length > 128 ||
      !event?.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new Error('invalid_paddle_event');
  }

  // Hash a canonical representation so object-key ordering cannot turn an
  // identical verified delivery into a false conflict. The raw payload is
  // still retained only while the inbox item is pending/retryable.
  const serializedPayload = stableJsonStringify(event);
  const payloadSha256 = createHash('sha256').update(serializedPayload).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO paddle_webhook_inbox
         (event_id, event_type, occurred_at, payload, payload_sha256, status)
       VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5, 'pending')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, eventType, occurredAt, serializedPayload, payloadSha256]
    );
    if (inserted.rowCount === 1) {
      await client.query('COMMIT');
      return { duplicate: false, queued: true, conflict: false };
    }

    const original = await client.query(
      `SELECT event_type, occurred_at, payload_sha256
         FROM paddle_webhook_inbox
        WHERE event_id = $1
        FOR UPDATE`,
      [eventId]
    );
    if (original.rowCount !== 1) throw new Error('paddle_webhook_inbox_conflict_lookup_failed');

    const first = original.rows[0];
    if (first.payload_sha256 && first.payload_sha256 === payloadSha256) {
      await client.query('COMMIT');
      return { duplicate: true, queued: false, conflict: false };
    }

    // A legacy row without a stored hash cannot be proven identical. Preserve
    // the conflicting delivery as hash-only evidence and fail closed.
    await client.query(
      `INSERT INTO paddle_webhook_inbox_conflicts
         (event_id, original_payload_sha256, conflicting_payload_sha256,
          conflicting_event_type, conflicting_occurred_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (event_id, conflicting_payload_sha256) DO NOTHING`,
      [eventId, first.payload_sha256, payloadSha256, eventType, occurredAt]
    );
    // If the original has not started processing, quarantine it so a conflicting
    // event ID cannot be applied by a worker after the conflict is known.
    await client.query(
      `UPDATE paddle_webhook_inbox
          SET status = 'dead_letter', payload = NULL,
              lease_token = NULL, lease_expires_at = NULL,
              last_error_code = 'event_id_payload_conflict'
        WHERE event_id = $1 AND status IN ('pending', 'retry')`,
      [eventId]
    );
    await client.query('COMMIT');
    return { duplicate: true, queued: false, conflict: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function claimPaddleWebhook(pool, {
  leaseMs = PADDLE_WEBHOOK_LEASE_MS
} = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 15 * 60_000) {
    throw new RangeError('Paddle webhook lease must be between 30 seconds and 15 minutes');
  }
  const client = await pool.connect();
  const leaseToken = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE paddle_webhook_inbox
       SET status = 'dead_letter', lease_token = NULL, lease_expires_at = NULL,
           payload = NULL, last_error_code = COALESCE(last_error_code, 'lease_expired_max_attempts')
       WHERE status = 'processing'
         AND lease_expires_at <= statement_timestamp()
         AND attempt_count >= $1`,
      [PADDLE_WEBHOOK_MAX_ATTEMPTS]
    );
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT event_id
         FROM paddle_webhook_inbox
         WHERE attempt_count < $1
           AND (
             (status IN ('pending', 'retry') AND next_attempt_at <= statement_timestamp())
             OR (status = 'processing' AND lease_expires_at <= statement_timestamp())
           )
         ORDER BY next_attempt_at, received_at, event_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE paddle_webhook_inbox AS inbox
       SET status = 'processing',
           attempt_count = inbox.attempt_count + 1,
           lease_token = $2::uuid,
           lease_expires_at = statement_timestamp() + ($3::bigint * INTERVAL '1 millisecond')
       FROM candidate
       WHERE inbox.event_id = candidate.event_id
       RETURNING inbox.event_id, inbox.payload, inbox.attempt_count, inbox.lease_token`,
      [PADDLE_WEBHOOK_MAX_ATTEMPTS, leaseToken, leaseMs]
    );
    await client.query('COMMIT');
    return claimed.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatPaddleWebhook(pool, eventId, leaseToken, {
  leaseMs = PADDLE_WEBHOOK_LEASE_MS
} = {}) {
  const result = await pool.query(
    `UPDATE paddle_webhook_inbox
     SET lease_expires_at = statement_timestamp() + ($3::bigint * INTERVAL '1 millisecond')
     WHERE event_id = $1 AND status = 'processing' AND lease_token = $2::uuid
       AND lease_expires_at > statement_timestamp()`,
    [eventId, leaseToken, leaseMs]
  );
  return result.rowCount === 1;
}

export async function completePaddleWebhook(pool, eventId, leaseToken) {
  const result = await pool.query(
    `UPDATE paddle_webhook_inbox
     SET status = 'completed', processed_at = statement_timestamp(),
         payload = NULL, lease_token = NULL, lease_expires_at = NULL,
         last_error_code = NULL
     WHERE event_id = $1 AND status = 'processing' AND lease_token = $2::uuid
       AND lease_expires_at > statement_timestamp()`,
    [eventId, leaseToken]
  );
  return result.rowCount === 1;
}

export async function failPaddleWebhook(pool, eventId, leaseToken, attempt, error) {
  const terminal = attempt >= PADDLE_WEBHOOK_MAX_ATTEMPTS;
  const delay = terminal ? 0 : paddleWebhookRetryDelayMs(attempt);
  const result = await pool.query(
    `UPDATE paddle_webhook_inbox
     SET status = $3,
         next_attempt_at = statement_timestamp() + ($4::bigint * INTERVAL '1 millisecond'),
         lease_token = NULL, lease_expires_at = NULL,
         payload = CASE WHEN $3 = 'dead_letter' THEN NULL ELSE payload END,
         last_error_code = $5
     WHERE event_id = $1 AND status = 'processing' AND lease_token = $2::uuid
       AND lease_expires_at > statement_timestamp()`,
    [eventId, leaseToken, terminal ? 'dead_letter' : 'retry', delay, safeErrorCode(error)]
  );
  return result.rowCount === 1;
}

export async function processOnePaddleWebhook(pool, processEvent, {
  leaseMs = PADDLE_WEBHOOK_LEASE_MS
} = {}) {
  const job = await claimPaddleWebhook(pool, { leaseMs });
  if (!job) return { claimed: false };
  if (!job.payload || typeof job.payload !== 'object') {
    await failPaddleWebhook(pool, job.event_id, job.lease_token, job.attempt_count,
      Object.assign(new Error('missing_paddle_webhook_payload'), { code: 'missing_paddle_webhook_payload' }));
    return { claimed: true, processed: false };
  }
  let heartbeatBusy = false;
  let leaseLost = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      if (!await heartbeatPaddleWebhook(pool, job.event_id, job.lease_token, { leaseMs })) leaseLost = true;
    } catch {
      // The completion update is still fenced; a failed heartbeat cannot authorize a stale worker.
    } finally {
      heartbeatBusy = false;
    }
  }, Math.max(10_000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  try {
    await processEvent(pool, job.payload);
    const completed = await completePaddleWebhook(pool, job.event_id, job.lease_token);
    return { claimed: true, processed: completed, leaseLost: leaseLost || !completed };
  } catch (error) {
    const recorded = await failPaddleWebhook(pool, job.event_id, job.lease_token, job.attempt_count, error);
    return { claimed: true, processed: false, retryScheduled: recorded, errorCode: safeErrorCode(error) };
  } finally {
    clearInterval(heartbeat);
  }
}
