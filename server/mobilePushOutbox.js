import {
  decryptMobilePushToken,
  parseMobilePushTokenEncryptionKey,
  safeMobilePushPayload
} from './mobilePushTokens.js';
import { sendMobilePush, mobilePushRetryDelayMs } from './mobilePushDelivery.js';

const MAX_ATTEMPTS = 10;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

export function normalizeMobilePushBatchSize(value = DEFAULT_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError('mobile push batch size must be an integer between 1 and 500');
  }
  return batchSize;
}

export async function processMobilePushOutboxBatch(pool, {
  batchSize = DEFAULT_BATCH_SIZE,
  send = sendMobilePush,
  env = process.env
} = {}) {
  const limit = normalizeMobilePushBatchSize(batchSize);
  const key = parseMobilePushTokenEncryptionKey(env.MOBILE_PUSH_TOKEN_ENCRYPTION_KEY);
  if (!key) return { disabled: true, claimed: 0, sent: 0, retried: 0, failed: 0 };

  let client;
  let claimed = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `UPDATE mobile_push_outbox outbox
       SET status = 'failed', lease_expires_at = NULL,
           last_error_code = 'push_recipient_or_token_unavailable'
       FROM mobile_push_tokens token
       LEFT JOIN mobile_sessions session ON session.id = token.session_id
       LEFT JOIN users recipient ON recipient.id = token.user_id
       WHERE outbox.token_id = token.id
         AND recipient.id = outbox.user_id
         AND outbox.status IN ('pending', 'retry', 'processing')
         AND (token.revoked_at IS NOT NULL OR session.id IS NULL OR
              session.revoked_at IS NOT NULL OR session.refresh_expires_at <= NOW() OR
              recipient.status IS DISTINCT FROM 'active')`
    );
    const result = await client.query(
      `WITH due AS (
         SELECT outbox.id
         FROM mobile_push_outbox outbox
         JOIN mobile_push_tokens token ON token.id = outbox.token_id
         JOIN mobile_sessions session ON session.id = token.session_id
         JOIN users recipient ON recipient.id = outbox.user_id
         WHERE recipient.status = 'active'
           AND token.revoked_at IS NULL
           AND session.revoked_at IS NULL
           AND session.refresh_expires_at > NOW()
           AND (
             (outbox.status IN ('pending', 'retry') AND outbox.next_attempt_at <= NOW())
             OR (outbox.status = 'processing' AND outbox.lease_expires_at <= NOW())
           )
         ORDER BY outbox.created_at, outbox.id
         FOR UPDATE OF outbox SKIP LOCKED
         LIMIT $1
       )
       UPDATE mobile_push_outbox outbox
       SET status = 'processing',
           attempt_count = LEAST(outbox.attempt_count + 1, 100),
           lease_expires_at = NOW() + INTERVAL '2 minutes'
       FROM due
       WHERE outbox.id = due.id
       RETURNING outbox.id, outbox.user_id AS "userId", outbox.token_id AS "tokenId",
                 outbox.event_type AS "eventType", outbox.attempt_count AS "attemptCount"`,
      [limit]
    );
    claimed = result.rows;
    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    client?.release();
  }

  const summary = { disabled: false, claimed: claimed.length, sent: 0, retried: 0, failed: 0 };
  for (const item of claimed) {
    try {
      const current = await pool.query(
        `SELECT token.platform, token.token_ciphertext AS "tokenCiphertext",
                token.revoked_at AS "tokenRevokedAt",
                session.revoked_at AS "sessionRevokedAt",
                session.refresh_expires_at AS "refreshExpiresAt",
                recipient.status AS "recipientStatus"
         FROM mobile_push_tokens token
         JOIN mobile_sessions session ON session.id = token.session_id
         JOIN users recipient ON recipient.id = token.user_id
         WHERE token.id = $1 AND token.user_id = $2`,
        [item.tokenId, item.userId]
      );
      const device = current.rows[0];
      if (!device || device.tokenRevokedAt || device.sessionRevokedAt ||
          new Date(device.refreshExpiresAt).getTime() <= Date.now() ||
          device.recipientStatus !== 'active') {
        await pool.query(
          `UPDATE mobile_push_outbox
           SET status = 'failed', lease_expires_at = NULL,
               last_error_code = 'push_recipient_or_token_unavailable'
           WHERE id = $1 AND status = 'processing'`,
          [item.id]
        );
        summary.failed += 1;
        continue;
      }
      const payload = safeMobilePushPayload(item.eventType);
      if (!payload) {
        await pool.query(
          `UPDATE mobile_push_outbox
           SET status = 'failed', lease_expires_at = NULL, last_error_code = 'unsupported_push_event'
           WHERE id = $1 AND status = 'processing'`,
          [item.id]
        );
        summary.failed += 1;
        continue;
      }
      const token = decryptMobilePushToken(device.tokenCiphertext, key);
      let outcome;
      try {
        outcome = await send({ platform: device.platform, token, payload, env });
      } catch {
        outcome = { outcome: 'retry', errorCode: 'provider_unavailable' };
      }
      if (outcome?.outcome === 'sent') {
        await pool.query(
          `UPDATE mobile_push_outbox
           SET status = 'sent', sent_at = statement_timestamp(), lease_expires_at = NULL,
               provider_message_id = $2, last_error_code = NULL
           WHERE id = $1 AND status = 'processing'`,
          [item.id, outcome.providerMessageId || null]
        );
        summary.sent += 1;
      } else if (outcome?.outcome === 'invalid_token') {
        await pool.query(
          `UPDATE mobile_push_tokens
           SET revoked_at = statement_timestamp(), revoked_reason = 'provider_unregistered',
               updated_at = statement_timestamp()
           WHERE id = $1 AND revoked_at IS NULL`,
          [item.tokenId]
        );
        await pool.query(
          `UPDATE mobile_push_outbox
           SET status = 'failed', lease_expires_at = NULL, last_error_code = 'push_token_unregistered'
           WHERE id = $1 AND status = 'processing'`,
          [item.id]
        );
        summary.failed += 1;
      } else if (outcome?.outcome === 'retry' && item.attemptCount < MAX_ATTEMPTS) {
        const delayMs = mobilePushRetryDelayMs(item.attemptCount);
        await pool.query(
          `UPDATE mobile_push_outbox
           SET status = 'retry', next_attempt_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
               lease_expires_at = NULL, last_error_code = $3
           WHERE id = $1 AND status = 'processing'`,
          [item.id, delayMs, outcome.errorCode || 'provider_unavailable']
        );
        summary.retried += 1;
      } else {
        await pool.query(
          `UPDATE mobile_push_outbox
           SET status = 'failed', lease_expires_at = NULL,
               last_error_code = $2
           WHERE id = $1 AND status = 'processing'`,
          [item.id, outcome?.errorCode || 'push_delivery_failed']
        );
        summary.failed += 1;
      }
    } catch {
      await pool.query(
        `UPDATE mobile_push_outbox
         SET status = CASE WHEN attempt_count < $2 THEN 'retry' ELSE 'failed' END,
             next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
             lease_expires_at = NULL, last_error_code = 'push_worker_error'
         WHERE id = $1 AND status = 'processing'`,
        [item.id, MAX_ATTEMPTS, mobilePushRetryDelayMs(Math.max(1, item.attemptCount))]
      );
      if (item.attemptCount < MAX_ATTEMPTS) summary.retried += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}
