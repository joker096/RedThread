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
    `SELECT DISTINCT match_id AS "matchId",
            sender_id AS "senderId",
            recipient_id AS "recipientId"
     FROM gift_delivery_orders
     WHERE status = 'awaiting_recipient_consent'
       AND expires_at <= NOW()
     ORDER BY "matchId", "senderId", "recipientId"
     LIMIT $1`,
    [limit]
  );

  const summary = { pairsScanned: candidates.rows.length, expiredOrders: 0, reconciliationRequired: 0 };
  for (const pair of candidates.rows) {
    const client = await pool.connect();
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
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
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
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Gift request expiry failed:', error.message);
    process.exitCode = 1;
  });
}
