import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { acquireGiftSafetyUserLocks } from './giftOrderCreationService.js';

const { Pool } = pg;
export const DEFAULT_IDENTITY_L3_EXPIRY_BATCH_SIZE = 100;
export const IDENTITY_L3_PENDING_REVIEW_RETENTION_DAYS = 30;

export function normalizeIdentityL3ExpiryBatchSize(value = DEFAULT_IDENTITY_L3_EXPIRY_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('identity L3 expiry batch size must be an integer between 1 and 1000');
  }
  return batchSize;
}

/**
 * Expire approvals and stale pending-review submissions in bounded account
 * batches. Candidate discovery takes no row locks; each account is serialized
 * behind the same safety advisory lock used by account deletion and restricted
 * identity-gated actions. Authorization checks expiry synchronously; this worker
 * performs audit/state cleanup and queues physical media deletion.
 */
export async function processExpiredIdentityL3ApprovalBatch(pool, {
  batchSize = DEFAULT_IDENTITY_L3_EXPIRY_BATCH_SIZE,
  acquireSafetyLocks = acquireGiftSafetyUserLocks
} = {}) {
  const limit = normalizeIdentityL3ExpiryBatchSize(batchSize);
  const candidates = await pool.query(
    `SELECT candidates.user_id
     FROM (
       SELECT DISTINCT user_id
       FROM identity_l3_submissions
       WHERE (status = 'approved' AND expires_at <= NOW())
          OR (status = 'pending_review'
              AND processing_completed_at <= NOW() - ($2::int * INTERVAL '1 day'))
     ) candidates
     ORDER BY md5(concat_ws(':', candidates.user_id::text, date_trunc('minute', NOW())::text))
     LIMIT $1`,
    [limit, IDENTITY_L3_PENDING_REVIEW_RETENTION_DAYS]
  );

  const summary = {
    accountsScanned: candidates.rows.length,
    approvalsExpired: 0,
    pendingReviewsExpired: 0,
    accountFailures: 0
  };
  for (const candidate of candidates.rows) {
    let client;
    let releaseError;
    let transactionOpen = false;
    try {
      client = await pool.connect();
      try {
        await client.query('BEGIN');
        transactionOpen = true;
      } catch (error) {
        // A failed BEGIN can leave the connection protocol state uncertain.
        releaseError = error;
        throw error;
      }

      await acquireSafetyLocks(client, candidate.user_id);
      await client.query(
        "SELECT set_config('app.identity_l3_actor_user_id', '', true), set_config('app.identity_l3_reason_code', 'approval_expired', true)"
      );
      const expiredApprovals = await client.query(
        `UPDATE identity_l3_submissions
         SET status = 'expired'
         WHERE user_id = $1 AND status = 'approved' AND expires_at <= NOW()
         RETURNING id`,
        [candidate.user_id]
      );
      await client.query(
        "SELECT set_config('app.identity_l3_actor_user_id', '', true), set_config('app.identity_l3_reason_code', 'moderation_retention_expired', true)"
      );
      const expiredPendingReviews = await client.query(
        `UPDATE identity_l3_submissions
         SET status = 'expired'
         WHERE user_id = $1 AND status = 'pending_review'
           AND processing_completed_at <= NOW() - ($2::int * INTERVAL '1 day')
         RETURNING id`,
        [candidate.user_id, IDENTITY_L3_PENDING_REVIEW_RETENTION_DAYS]
      );
      await client.query('COMMIT');
      transactionOpen = false;
      summary.approvalsExpired += expiredApprovals.rowCount ?? expiredApprovals.rows?.length ?? 0;
      summary.pendingReviewsExpired += expiredPendingReviews.rowCount ?? expiredPendingReviews.rows?.length ?? 0;
    } catch (error) {
      if (client && transactionOpen) {
        try {
          await client.query('ROLLBACK');
          transactionOpen = false;
        } catch (rollbackError) {
          releaseError = rollbackError;
        }
      }
      summary.accountFailures += 1;
      const safeErrorCode = typeof error?.code === 'string' ? error.code : 'unexpected_error';
      console.error('L3 approval expiry account failed:', safeErrorCode);
    } finally {
      client?.release(releaseError);
    }
  }
  return summary;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for identity L3 expiry');
  const batchSize = normalizeIdentityL3ExpiryBatchSize(
    process.env.IDENTITY_L3_EXPIRY_BATCH_SIZE || DEFAULT_IDENTITY_L3_EXPIRY_BATCH_SIZE
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const summary = await processExpiredIdentityL3ApprovalBatch(pool, { batchSize });
    console.log('Identity L3 expiry batch completed:', JSON.stringify(summary));
    if (summary.accountFailures > 0) {
      throw new Error(`identity L3 expiry batch had ${summary.accountFailures} account failure(s)`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safeErrorCode = typeof error?.code === 'string' ? error.code : 'unexpected_error';
    console.error('Identity L3 expiry failed:', safeErrorCode);
    process.exitCode = 1;
  });
}
