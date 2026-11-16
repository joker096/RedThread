import { GIFT_ADDRESS_DRAFT_CONSENT_VERSION } from './giftAddressDraft.js';

export const DEFAULT_GIFT_ADDRESS_DRAFT_PURGE_BATCH_SIZE = 100;
export function normalizeGiftAddressDraftPurgeBatchSize(value = DEFAULT_GIFT_ADDRESS_DRAFT_PURGE_BATCH_SIZE) {
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new RangeError('gift address draft purge batch size invalid');
  return size;
}

/** Deletes expired ciphertext rows from the live store and appends a non-PII expiry event atomically. */
export async function purgeExpiredGiftAddressDrafts(pool, {
  batchSize = DEFAULT_GIFT_ADDRESS_DRAFT_PURGE_BATCH_SIZE
} = {}) {
  const limit = normalizeGiftAddressDraftPurgeBatchSize(batchSize);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH due AS (
         SELECT order_id, recipient_user_id
           FROM gift_address_drafts
          WHERE expires_at <= statement_timestamp()
          ORDER BY expires_at, order_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM gift_address_drafts d
          USING due
          WHERE d.order_id = due.order_id
          RETURNING d.order_id, d.recipient_user_id
       ), expired AS (
         INSERT INTO gift_address_draft_consent_events
           (order_id, recipient_user_id, consent_version, action, actor_user_id)
         SELECT order_id, recipient_user_id, consent_version, 'expired', NULL
           FROM deleted
         RETURNING order_id
       )
       SELECT COUNT(*)::int AS purged FROM expired`,
      [limit, GIFT_ADDRESS_DRAFT_CONSENT_VERSION]
    );
    await client.query('COMMIT');
    return { purged: Number(result.rows[0]?.purged || 0) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

