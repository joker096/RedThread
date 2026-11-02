import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  IdentityL3MediaProcessingError,
  processIdentityL3Media
} from './identityL3MediaProcessing.js';
import { deleteIdentityL3Object, openIdentityL3Stream, parseIdentityL3EncryptionKey, sweepIdentityL3OrphanObjects } from './identityL3Storage.js';

const { Pool } = pg;
export const IDENTITY_L3_WORKER_LEASE_MS = 180_000;
export const IDENTITY_L3_WORKER_HEARTBEAT_MS = 30_000;
export const IDENTITY_L3_WORKER_MAX_ATTEMPTS = 5;

const RETRYABLE_ERROR_CODES = new Set([
  'l3_media_scanner_unavailable',
  'l3_media_scanner_timeout',
  'l3_media_probe_unavailable',
  'l3_media_probe_timeout',
  'l3_media_probe_failed',
  'l3_media_scanner_rejected',
  'l3_media_processing_failed',
  'l3_storage_root_missing',
  'l3_storage_root_unsafe'
]);
const PERMANENT_ERROR_CODES = new Set([
  'l3_media_malware_detected',
  'l3_media_format_or_duration_invalid',
  'l3_media_format_or_codec_invalid',
  'l3_media_audio_codec_invalid',
  'l3_media_mime_type_invalid',
  'l3_media_probe_invalid',
  'l3_media_probe_output_too_large',
  'l3_media_too_large',
  'l3_media_empty',
  'l3_storage_authentication_failed',
  'l3_storage_object_invalid',
  'l3_storage_object_key_invalid'
]);

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'l3_media_processing_failed';
}

export function identityL3RetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > IDENTITY_L3_WORKER_MAX_ATTEMPTS) {
    throw new RangeError('identity L3 processing attempt is outside the supported range');
  }
  return Math.min(60 * 60_000, 60_000 * (2 ** (attempt - 1)));
}

export function isPermanentIdentityL3ProcessingError(error) {
  const code = safeErrorCode(error);
  if (PERMANENT_ERROR_CODES.has(code)) return true;
  return !RETRYABLE_ERROR_CODES.has(code) &&
    error instanceof IdentityL3MediaProcessingError;
}

async function releaseAccountLock(client, userId) {
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
    `gift-safety-user:${userId}`
  ]);
}

/**
 * Claim one row using a fencing token. The session advisory lock is deliberately
 * held for the whole media-processing operation and is identical to the lock
 * used by account deletion and upload authorization.
 */
export async function claimIdentityL3Submission(pool, {
  leaseMs = IDENTITY_L3_WORKER_LEASE_MS
} = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 10 * 60_000) {
    throw new RangeError('identity L3 worker lease must be between 30 seconds and 10 minutes');
  }
  const candidate = await pool.query(
    `SELECT id, user_id
     FROM identity_l3_submissions
     WHERE status IN ('uploaded', 'processing')
       AND processing_attempts < $1
       AND processing_next_attempt_at <= statement_timestamp()
       AND (processing_lease_expires_at IS NULL
            OR processing_lease_expires_at <= statement_timestamp())
     ORDER BY processing_next_attempt_at, uploaded_at, id
     LIMIT 1`,
    [IDENTITY_L3_WORKER_MAX_ATTEMPTS]
  );
  const selected = candidate.rows[0];
  if (!selected) return null;

  const client = await pool.connect();
  let lockAcquired = false;
  let transactionOpen = false;
  let discardConnection = false;
  try {
    const lockKey = `gift-safety-user:${selected.user_id}`;
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    lockAcquired = true;
    await client.query('BEGIN');
    transactionOpen = true;

    const active = await client.query(
      "SELECT id FROM users WHERE id = $1 AND status = 'active' FOR SHARE",
      [selected.user_id]
    );
    if (!active.rowCount) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      await releaseAccountLock(client, selected.user_id);
      lockAcquired = false;
      client.release();
      return null;
    }

    const locked = await client.query(
      `SELECT id, user_id, status, storage_object_key, media_mime_type,
              processing_attempts
       FROM identity_l3_submissions
       WHERE id = $1 AND user_id = $2
         AND status IN ('uploaded', 'processing')
         AND processing_attempts < $3
         AND processing_next_attempt_at <= statement_timestamp()
         AND (processing_lease_expires_at IS NULL
              OR processing_lease_expires_at <= statement_timestamp())
       FOR UPDATE SKIP LOCKED`,
      [selected.id, selected.user_id, IDENTITY_L3_WORKER_MAX_ATTEMPTS]
    );
    const row = locked.rows[0];
    if (!row || !row.storage_object_key || !row.media_mime_type) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      await releaseAccountLock(client, selected.user_id);
      lockAcquired = false;
      client.release();
      return null;
    }

    const leaseToken = randomUUID();
    await client.query(
      "SELECT set_config('app.identity_l3_actor_user_id', '', true), set_config('app.identity_l3_reason_code', 'media_processing_started', true)"
    );
    const claimed = await client.query(
      `UPDATE identity_l3_submissions
       SET status = 'processing',
           processing_attempts = processing_attempts + 1,
           processing_lease_token = $2,
           processing_lease_expires_at = statement_timestamp() + ($3::int * INTERVAL '1 millisecond'),
           processing_last_error_code = NULL
       WHERE id = $1
       RETURNING id, user_id, storage_object_key, media_mime_type,
                 processing_attempts, processing_lease_expires_at`,
      [row.id, leaseToken, leaseMs]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { client, row: claimed.rows[0], leaseToken, lockKey };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        discardConnection = true;
        error.rollbackError = rollbackError;
      }
    }
    if (lockAcquired && !discardConnection) {
      try {
        await releaseAccountLock(client, selected.user_id);
        lockAcquired = false;
      } catch {
        discardConnection = true;
      }
    }
    client.release(discardConnection ? error : undefined);
    throw error;
  }
}

/**
 * Run the claimed job. A heartbeat extends the lease; completion is fenced by
 * the exact lease token, so an expired worker cannot overwrite a newer attempt.
 */
export async function processClaimedIdentityL3Submission(pool, claim, {
  storageRoot = process.env.IDENTITY_L3_STORAGE_DIR,
  encryptionKey = process.env.IDENTITY_L3_ENCRYPTION_KEY,
  leaseMs = IDENTITY_L3_WORKER_LEASE_MS,
  heartbeatMs = IDENTITY_L3_WORKER_HEARTBEAT_MS,
  processMedia = processIdentityL3Media
} = {}) {
  const { client, row, leaseToken } = claim;
  if (!storageRoot || !encryptionKey) {
    throw new Error('identity_l3_worker_storage_not_configured');
  }
  const parsedKey = parseIdentityL3EncryptionKey(encryptionKey);
  let heartbeatRunning = false;
  let leaseLost = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning || leaseLost) return;
    heartbeatRunning = true;
    try {
      const extended = await client.query(
        `UPDATE identity_l3_submissions
         SET processing_lease_expires_at = statement_timestamp() + ($3::int * INTERVAL '1 millisecond')
         WHERE id = $1 AND status = 'processing'
           AND processing_lease_token = $2
         RETURNING id`,
        [row.id, leaseToken, leaseMs]
      );
      if (!extended.rowCount) leaseLost = true;
    } catch {
      leaseLost = true;
    } finally {
      heartbeatRunning = false;
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  let processingResult;
  let processingError;
  try {
    processingResult = await processMedia({
      objectKey: row.storage_object_key,
      storageRoot,
      encryptionKey: parsedKey,
      declaredMimeType: row.media_mime_type,
      openDecryptedStream: ({ objectKey, root, key }) =>
        openIdentityL3Stream({ objectKey, root, key })
    });
  } catch (error) {
    processingError = error;
  } finally {
    clearInterval(heartbeat);
    // Do not race a final in-flight lease extension against the completion or
    // retry transaction on this same PostgreSQL connection.
    while (heartbeatRunning) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  if (leaseLost) throw new Error('identity_l3_worker_lease_lost');
  if (!processingError) {
    await client.query('BEGIN');
    try {
      await client.query(
        "SELECT set_config('app.identity_l3_actor_user_id', '', true), set_config('app.identity_l3_reason_code', 'media_processing_completed', true)"
      );
      const completed = await client.query(
        `UPDATE identity_l3_submissions
         SET status = 'pending_review',
             media_duration_seconds = $3,
             processing_completed_at = statement_timestamp(),
             processing_lease_token = NULL,
             processing_lease_expires_at = NULL,
             processing_last_error_code = NULL,
             processing_next_attempt_at = statement_timestamp()
         WHERE id = $1 AND status = 'processing'
           AND processing_lease_token = $2
           AND processing_lease_expires_at > statement_timestamp()
         RETURNING id`,
        [row.id, leaseToken, processingResult.durationSeconds]
      );
      if (!completed.rowCount) throw new Error('identity_l3_worker_lease_lost');
      await client.query('COMMIT');
      return { status: 'pending_review', durationSeconds: processingResult.durationSeconds };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  const errorCode = safeErrorCode(processingError);
  const terminal = isPermanentIdentityL3ProcessingError(processingError) ||
    row.processing_attempts >= IDENTITY_L3_WORKER_MAX_ATTEMPTS;
  const retryDelay = terminal ? 0 : identityL3RetryDelayMs(row.processing_attempts);
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT set_config('app.identity_l3_actor_user_id', '', true), set_config('app.identity_l3_reason_code', $1, true)",
      [terminal ? 'media_processing_failed' : 'media_processing_retry']
    );
    const failed = await client.query(
      `UPDATE identity_l3_submissions
       SET status = CASE WHEN $3::boolean THEN 'failed' ELSE 'processing' END,
           processing_lease_token = NULL,
           processing_lease_expires_at = NULL,
           processing_next_attempt_at = statement_timestamp() + ($4::int * INTERVAL '1 millisecond'),
           processing_last_error_code = $5
       WHERE id = $1 AND status = 'processing'
         AND processing_lease_token = $2
       RETURNING id`,
      [row.id, leaseToken, terminal, retryDelay, errorCode]
    );
    if (!failed.rowCount) throw new Error('identity_l3_worker_lease_lost');
    await client.query('COMMIT');
    return { status: terminal ? 'failed' : 'retry_scheduled', errorCode, retryDelay };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function runIdentityL3WorkerOnce(pool, options = {}) {
  const claim = await claimIdentityL3Submission(pool, options);
  if (!claim) return { processed: false };
  try {
    const result = await processClaimedIdentityL3Submission(pool, claim, options);
    return { processed: true, submissionId: claim.row.id, ...result };
  } finally {
    try {
      await releaseAccountLock(claim.client, claim.row.user_id);
      claim.client.release();
    } catch (error) {
      claim.client.release(error);
      throw error;
    }
  }
}


export async function sweepIdentityL3Orphans(pool, {
  storageRoot = process.env.IDENTITY_L3_STORAGE_DIR,
  olderThanMs
} = {}) {
  if (!storageRoot) throw Object.assign(new Error('l3_storage_root_missing'), { code: 'l3_storage_root_missing' });
  const referenced = await pool.query(
    'SELECT storage_object_key FROM identity_l3_submissions WHERE storage_object_key IS NOT NULL'
  );
  return sweepIdentityL3OrphanObjects({
    root: storageRoot,
    referencedObjectKeys: referenced.rows.map(row => row.storage_object_key),
    ...(olderThanMs === undefined ? {} : { olderThanMs })
  });
}

export const IDENTITY_L3_PURGE_MAX_ATTEMPTS = 5;
export const IDENTITY_L3_PURGE_LEASE_MS = 180_000;

export function identityL3PurgeRetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > IDENTITY_L3_PURGE_MAX_ATTEMPTS) {
    throw new RangeError('identity L3 purge attempt is outside the supported range');
  }
  return Math.min(60 * 60_000, 60_000 * (2 ** (attempt - 1)));
}

/**
 * Purge jobs share the account advisory lock with uploads, processing, consent
 * withdrawal and account deletion. A missing file is treated as already deleted,
 * making the unlink -> database-commit crash window safely retryable.
 */
export async function runIdentityL3PurgeOnce(pool, {
  storageRoot = process.env.IDENTITY_L3_STORAGE_DIR,
  deleteObject = deleteIdentityL3Object
} = {}) {
  const candidate = await pool.query(
    `SELECT j.id, j.user_id
     FROM identity_l3_media_purge_jobs j
     WHERE j.status IN ('queued', 'processing')
       AND j.attempts < $1
       AND j.next_attempt_at <= statement_timestamp()
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= statement_timestamp())
     ORDER BY j.next_attempt_at, j.created_at, j.id
     LIMIT 1`,
    [IDENTITY_L3_PURGE_MAX_ATTEMPTS]
  );
  const selected = candidate.rows[0];
  if (!selected) return { processed: false };

  const client = await pool.connect();
  let lockAcquired = false;
  let transactionOpen = false;
  let discardError = null;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
      `gift-safety-user:${selected.user_id}`
    ]);
    lockAcquired = true;
    await client.query('BEGIN');
    transactionOpen = true;
    const locked = await client.query(
      `SELECT j.id, j.submission_id, j.user_id, j.attempts,
              s.status AS submission_status, s.storage_object_key,
              s.media_purged_at
       FROM identity_l3_media_purge_jobs j
       JOIN identity_l3_submissions s
         ON s.id = j.submission_id AND s.user_id = j.user_id
       WHERE j.id = $1
         AND j.status IN ('queued', 'processing')
         AND j.attempts < $2
         AND j.next_attempt_at <= statement_timestamp()
         AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= statement_timestamp())
       FOR UPDATE OF j, s SKIP LOCKED`,
      [selected.id, IDENTITY_L3_PURGE_MAX_ATTEMPTS]
    );
    const job = locked.rows[0];
    if (!job) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      await releaseAccountLock(client, selected.user_id);
      lockAcquired = false;
      return { processed: false };
    }
    if (!['rejected', 'withdrawn', 'revoked', 'expired', 'failed'].includes(job.submission_status)) {
      throw new Error('identity_l3_purge_submission_not_terminal');
    }
    const leaseToken = randomUUID();
    const attempt = job.attempts + 1;
    await client.query(
      `UPDATE identity_l3_media_purge_jobs
       SET status = 'processing', attempts = $2, lease_token = $3,
           lease_expires_at = statement_timestamp() + ($4::int * INTERVAL '1 millisecond'),
           updated_at = statement_timestamp(), last_error_code = NULL
       WHERE id = $1`,
      [job.id, attempt, leaseToken, IDENTITY_L3_PURGE_LEASE_MS]
    );
    await client.query('COMMIT');
    transactionOpen = false;

    try {
      if (job.storage_object_key) {
        if (!storageRoot) throw Object.assign(new Error('l3_storage_root_missing'), { code: 'l3_storage_root_missing' });
        await deleteObject({ objectKey: job.storage_object_key, root: storageRoot });
      }

      await client.query('BEGIN');
      transactionOpen = true;
      await client.query(
        "SELECT set_config('app.identity_l3_actor_user_id', '', true), set_config('app.identity_l3_reason_code', 'media_purged', true)"
      );
      if (job.storage_object_key) {
        const cleared = await client.query(
          `UPDATE identity_l3_submissions
           SET storage_object_key = NULL,
               media_purged_at = COALESCE(media_purged_at, statement_timestamp())
           WHERE id = $1 AND user_id = $2
             AND storage_object_key = $3
             AND status IN ('rejected', 'withdrawn', 'revoked', 'expired', 'failed')
           RETURNING id`,
          [job.submission_id, job.user_id, job.storage_object_key]
        );
        if (!cleared.rowCount) throw Object.assign(new Error('identity_l3_purge_submission_changed'), { code: 'identity_l3_purge_submission_changed' });
      }
      const completed = await client.query(
        `UPDATE identity_l3_media_purge_jobs
         SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
             completed_at = statement_timestamp(), updated_at = statement_timestamp(),
             last_error_code = NULL
         WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
        [job.id, leaseToken]
      );
      if (!completed.rowCount) throw Object.assign(new Error('identity_l3_purge_lease_lost'), { code: 'identity_l3_purge_lease_lost' });
      await client.query('COMMIT');
      transactionOpen = false;
      return { processed: true, purgeJobId: job.id, status: 'completed' };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
        transactionOpen = false;
      }
      const code = safeErrorCode(error);
      const terminal = attempt >= IDENTITY_L3_PURGE_MAX_ATTEMPTS;
      const delay = terminal ? 0 : identityL3PurgeRetryDelayMs(attempt);
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query(
        `UPDATE identity_l3_media_purge_jobs
         SET status = $3, lease_token = NULL, lease_expires_at = NULL,
             next_attempt_at = statement_timestamp() + ($4::int * INTERVAL '1 millisecond'),
             last_error_code = $5, updated_at = statement_timestamp()
         WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
        [job.id, leaseToken, terminal ? 'failed' : 'queued', delay, code]
      );
      await client.query('COMMIT');
      transactionOpen = false;
      const errorDiagnostic = typeof error?.message === 'string' &&
        /^[a-zA-Z0-9 _.:()'-]{1,180}$/.test(error.message)
        ? error.message : code;
      return {
        processed: true,
        purgeJobId: job.id,
        status: terminal ? 'failed' : 'retry_scheduled',
        errorCode: code,
        errorDiagnostic
      };
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
        discardError = error;
      }
    }
    throw error;
  } finally {
    if (lockAcquired && !discardError) {
      try {
        await releaseAccountLock(client, selected.user_id);
      } catch (error) {
        discardError = error;
      }
    }
    client.release(discardError || undefined);
  }
}

async function main() {
  const purgeOnly = process.argv.includes('--purge-only');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the identity L3 worker');
  if (!process.env.IDENTITY_L3_STORAGE_DIR || (!purgeOnly && !process.env.IDENTITY_L3_ENCRYPTION_KEY)) {
    throw new Error('identity L3 encrypted storage is not configured');
  }
  if (!purgeOnly) parseIdentityL3EncryptionKey(process.env.IDENTITY_L3_ENCRYPTION_KEY);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  let stopping = false;
  let lastOrphanSweepAt = 0;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      if (purgeOnly && Date.now() - lastOrphanSweepAt >= 60 * 60 * 1000) {
        const sweep = await sweepIdentityL3Orphans(pool);
        lastOrphanSweepAt = Date.now();
        if (sweep.deletedCount > 0) console.log('Identity L3 orphan files removed:', sweep.deletedCount);
      }
      const result = purgeOnly
        ? await runIdentityL3PurgeOnce(pool)
        : await runIdentityL3WorkerOnce(pool);
      if (!result.processed && !stopping) {
        await new Promise(resolve => setTimeout(resolve, 1_500));
      } else if (result.processed) {
        console.log('Identity L3 worker job completed:', JSON.stringify(result));
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Identity L3 worker stopped:', safeErrorCode(error));
    process.exitCode = 1;
  });
}
