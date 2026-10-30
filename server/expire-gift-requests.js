import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  acquireGiftOrderRateLocks,
  acquireGiftSafetyUserLocks,
  acquireGiftSafetyPairLock,
  expireStaleGiftRequestsForPair
} from './giftOrderCreationService.js';

const { Pool } = pg;
export const DEFAULT_GIFT_EXPIRY_BATCH_SIZE = 100;

export function normalizeGiftExpiryBatchSize(value = DEFAULT_GIFT_EXPIRY_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('gift expiry batch size must be an integer between 1 and 1000');
  }
  return batchSize;
}

/**
 * Process expired consent requests in bounded pair batches. Candidate discovery
 * takes no row locks: workers then acquire the same advisory locks, in the same
 * order as request creation/acceptance, before the shared expiry transaction.
 * This avoids lock-order inversion and makes concurrent workers idempotent.
 */
export async function processExpiredGiftRequestBatch(pool, {
  batchSize = DEFAULT_GIFT_EXPIRY_BATCH_SIZE,
  acquireRateLocks = acquireGiftOrderRateLocks,
  acquireSafetyLocks = acquireGiftSafetyUserLocks,
  acquirePairLock = acquireGiftSafetyPairLock,
  expirePair = expireStaleGiftRequestsForPair
} = {}) {
  const limit = normalizeGiftExpiryBatchSize(batchSize);
  const candidates = await pool.query(
    `SELECT candidates."matchId", candidates."senderId", candidates."recipientId"
     FROM (
       SELECT DISTINCT match_id AS "matchId",
              sender_id AS "senderId",
              recipient_id AS "recipientId"
       FROM gift_delivery_orders
       WHERE status = 'awaiting_recipient_consent'
         AND expires_at <= NOW()
         AND (
           payment_status IN ('not_started', 'voided', 'failed')
           OR NOT EXISTS (
             SELECT 1
             FROM gift_payment_reconciliation_tasks tasks
             WHERE tasks.order_id = gift_delivery_orders.id
               AND tasks.reason = 'expired_active_payment'
           )
         )
     ) candidates
     -- Rotate the bounded window each minute so a persistently failing early
     -- pair cannot monopolize the same first slots on every worker invocation.
     ORDER BY md5(concat_ws(':', candidates."matchId"::text,
                                 candidates."senderId"::text,
                                 candidates."recipientId"::text,
                                 date_trunc('minute', NOW())::text))
     LIMIT $1`,
    [limit]
  );

  const summary = { pairsScanned: candidates.rows.length, expiredOrders: 0, reconciliationRequired: 0, pairFailures: 0 };
  for (const pair of candidates.rows) {
    const client = await pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      await acquireRateLocks(client, pair.senderId, pair.recipientId);
      await acquireSafetyLocks(client, pair.senderId, pair.recipientId);
      await acquirePairLock(client, pair.senderId, pair.recipientId);
      const result = await expirePair(client, pair);
      // The helper deliberately asks callers to commit when it queued payment
      // reconciliation, even though the pair remains unavailable for replacement.
      if (result.commit === true || result.ok === true) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
        continue;
      }
      summary.expiredOrders += result.expiredOrders?.length ?? 0;
      if (result.error === 'gift_payment_requires_reconciliation') {
        summary.reconciliationRequired += 1;
      }
    } catch (error) {
      // Discard a client after any failed transaction operation. In particular,
      // a failed COMMIT/ROLLBACK can leave its protocol state uncertain; it must
      // not be handed back to the pool as a healthy connection.
      releaseError = error;
      await client.query('ROLLBACK').catch(rollbackError => {
        releaseError = rollbackError;
      });
      summary.pairFailures += 1;
      // Isolate a broken pair: a transient database/application error must not
      // abort the remaining bounded batch and starve unrelated expired requests.
      const safeErrorCode = typeof error?.code === 'string' ? error.code : 'unexpected_error';
      console.error('Gift request expiry pair failed:', safeErrorCode);
    } finally {
      client.release(releaseError);
    }
  }
  return summary;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for gift request expiry');
  const batchSize = normalizeGiftExpiryBatchSize(
    process.env.GIFT_EXPIRY_BATCH_SIZE || DEFAULT_GIFT_EXPIRY_BATCH_SIZE
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const summary = await processExpiredGiftRequestBatch(pool, { batchSize });
    console.log('Gift request expiry batch completed:', JSON.stringify(summary));
    if (summary.pairFailures > 0) {
      throw new Error(`gift request expiry batch had ${summary.pairFailures} pair failure(s)`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Database/client errors can contain SQL details or sensitive values.
    // Keep the top-level process log to a stable, non-sensitive error code.
    const safeErrorCode = typeof error?.code === 'string' ? error.code : 'unexpected_error';
    console.error('Gift request expiry failed:', safeErrorCode);
    process.exitCode = 1;
  });
}
