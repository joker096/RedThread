import { createHash, randomUUID } from 'node:crypto';
import {
  assertIdentityL3StorageRootReady,
  deleteIdentityL3Object
} from './identityL3Storage.js';

export const DEFAULT_IDENTITY_L3_PURGE_BATCH_SIZE = 100;
export const IDENTITY_L3_PURGE_MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export function normalizeIdentityL3PurgeBatchSize(value = DEFAULT_IDENTITY_L3_PURGE_BATCH_SIZE) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new TypeError('l3_purge_batch_size_invalid');
  }
  return parsed;
}

export function identityL3PurgeRetryDelayMs(attempts) {
  const parsed = Number(attempts);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError('l3_purge_attempts_invalid');
  return Math.min(IDENTITY_L3_PURGE_MAX_RETRY_DELAY_MS, 15_000 * (2 ** Math.min(parsed - 1, 10)));
}

function safeErrorCode(error) {
  const code = String(error?.code || '').toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'l3_media_purge_failed';
}

async function claimNextJob(pool, { leaseDurationMs }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE identity_l3_media_purge_jobs
          SET status = 'failed',
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = 'max_attempts_exhausted',
              updated_at = statement_timestamp()
        WHERE status = 'processing'
          AND lease_expires_at <= statement_timestamp()
          AND attempts >= $1`,
      [MAX_ATTEMPTS]
    );
    const leaseToken = randomUUID();
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT id
           FROM identity_l3_media_purge_jobs
          WHERE status IN ('queued', 'processing')
            AND attempts < $1
            AND next_attempt_at <= statement_timestamp()
            AND (status = 'queued' OR lease_expires_at <= statement_timestamp())
          ORDER BY next_attempt_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE identity_l3_media_purge_jobs AS job
          SET status = 'processing',
              attempts = job.attempts + 1,
              lease_token = $2,
              lease_expires_at = statement_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
              last_error_code = NULL,
              updated_at = statement_timestamp()
         FROM candidate
        WHERE job.id = candidate.id
       RETURNING job.id, job.submission_id, job.user_id, job.attempts,
                 job.lease_token, job.lease_expires_at`,
      [MAX_ATTEMPTS, leaseToken, leaseDurationMs]
    );
    if (!claimed.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const submission = await client.query(
      `SELECT storage_object_key, media_purged_at
         FROM identity_l3_submissions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [claimed.rows[0].submission_id, claimed.rows[0].user_id]
    );
    if (submission.rowCount !== 1 || !submission.rows[0].storage_object_key) {
      throw new Error('l3_purge_submission_object_key_missing');
    }
    await client.query('COMMIT');
    return { ...claimed.rows[0], objectKey: submission.rows[0].storage_object_key };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function completeJob(pool, job, objectKey) {
  const storageDigest = createHash('sha256').update(objectKey, 'utf8').digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedJob = await client.query(
      `SELECT id, submission_id, user_id, status, lease_token
         FROM identity_l3_media_purge_jobs
        WHERE id = $1 FOR UPDATE`,
      [job.id]
    );
    if (lockedJob.rowCount !== 1 || lockedJob.rows[0].status !== 'processing' ||
        lockedJob.rows[0].lease_token !== job.lease_token) {
      throw new Error('l3_purge_lease_lost');
    }
    const submission = await client.query(
      `SELECT storage_object_key, media_purged_at
         FROM identity_l3_submissions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [job.submission_id, job.user_id]
    );
    if (submission.rowCount !== 1 ||
        (submission.rows[0].storage_object_key !== objectKey &&
         !(submission.rows[0].storage_object_key === null && submission.rows[0].media_purged_at))) {
      throw new Error('l3_purge_submission_reference_changed');
    }
    if (submission.rows[0].storage_object_key === objectKey) {
      await client.query(
        `UPDATE identity_l3_submissions
            SET storage_object_key = NULL,
                media_purged_at = statement_timestamp()
          WHERE id = $1 AND user_id = $2 AND storage_object_key = $3`,
        [job.submission_id, job.user_id, objectKey]
      );
    }
    await client.query(
      `UPDATE identity_l3_media_purge_jobs
          SET status = 'completed',
              completed_at = statement_timestamp(),
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = NULL,
              updated_at = statement_timestamp()
        WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
      [job.id, job.lease_token]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_purge_completions
         (ledger_sequence, queue_name, storage_path_sha256)
       SELECT ledger_sequence, queue_name, storage_path_sha256
         FROM privacy_recovery_replay_purge_obligations
        WHERE queue_name = 'identity_l3_media'
          AND storage_path_sha256 = $1
       ON CONFLICT DO NOTHING`,
      [storageDigest]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function recordFailure(pool, job, error) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const attempts = Number(job.attempts);
    const terminal = attempts >= MAX_ATTEMPTS;
    const delayMs = identityL3PurgeRetryDelayMs(attempts);
    await client.query(
      `UPDATE identity_l3_media_purge_jobs
          SET status = $3,
              next_attempt_at = CASE WHEN $3 = 'queued'
                THEN statement_timestamp() + ($4::bigint * INTERVAL '1 millisecond')
                ELSE next_attempt_at END,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = $5,
              updated_at = statement_timestamp()
        WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
      [job.id, job.lease_token, terminal ? 'failed' : 'queued', delayMs, safeErrorCode(error)]
    );
    await client.query('COMMIT');
  } catch (failure) {
    await client.query('ROLLBACK').catch(() => {});
    throw failure;
  } finally {
    client.release();
  }
}

export async function processIdentityL3MediaPurgeBatch(pool, {
  storageRoot,
  batchSize = DEFAULT_IDENTITY_L3_PURGE_BATCH_SIZE,
  leaseDurationMs = DEFAULT_LEASE_MS,
  requireMount = process.env.IDENTITY_L3_REQUIRE_MOUNT === 'true',
  deleteObject = deleteIdentityL3Object
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('l3_purge_pool_required');
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) throw new Error('l3_storage_root_missing');
  const normalizedBatchSize = normalizeIdentityL3PurgeBatchSize(batchSize);
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 30_000 || leaseDurationMs > 30 * 60_000) {
    throw new TypeError('l3_purge_lease_duration_invalid');
  }
  if (typeof deleteObject !== 'function') throw new TypeError('l3_purge_delete_function_required');
  await assertIdentityL3StorageRootReady({ root: storageRoot, requireMount });

  const summary = { claimed: 0, deleted: 0, retried: 0, failed: 0, failures: 0 };
  for (let index = 0; index < normalizedBatchSize; index += 1) {
    const job = await claimNextJob(pool, { leaseDurationMs });
    if (!job) break;
    summary.claimed += 1;
    try {
      await deleteObject({ objectKey: job.objectKey, root: storageRoot });
      await completeJob(pool, job, job.objectKey);
      summary.deleted += 1;
    } catch (error) {
      await recordFailure(pool, job, error);
      summary.failures += 1;
      if (Number(job.attempts) >= MAX_ATTEMPTS) summary.failed += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}
