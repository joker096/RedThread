import path from 'node:path';

export const DEFAULT_PRIVATE_PHOTO_PURGE_BATCH_SIZE = 100;
export const PRIVATE_PHOTO_PURGE_MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

export function normalizePrivatePhotoPurgeBatchSize(value = DEFAULT_PRIVATE_PHOTO_PURGE_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('private photo purge batch size must be an integer between 1 and 1000');
  }
  return batchSize;
}

export function resolvePrivatePhotoPath(storagePath, storageRoot) {
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') {
    throw new TypeError('private photo storage root is not configured');
  }
  if (typeof storagePath !== 'string' || storagePath.length < 1 || storagePath.length > 2048) {
    throw new TypeError('private photo storage path is invalid');
  }

  const root = path.resolve(storageRoot);
  const resolved = path.resolve(storagePath);
  const relative = path.relative(root, resolved);
  const filename = path.basename(resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      path.dirname(resolved) !== root ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png)$/i.test(filename)) {
    const error = new Error('private photo storage path is outside the configured storage root');
    error.code = 'PHOTO_PATH_INVALID';
    throw error;
  }
  return resolved;
}

export function privatePhotoPurgeRetryDelayMs(attempts) {
  const count = Number(attempts);
  if (!Number.isInteger(count) || count < 0) throw new RangeError('attempts must be a non-negative integer');
  return Math.min(PRIVATE_PHOTO_PURGE_MAX_RETRY_DELAY_MS, 60_000 * (2 ** Math.min(count, 16)));
}

export async function queuePrivatePhotoPurges(client, storagePaths) {
  const paths = [...new Set((Array.isArray(storagePaths) ? storagePaths : [])
    .map(value => typeof value === 'string' ? value : '')
    .filter(value => value.length > 0))];
  if (paths.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO private_photo_purge_queue (storage_path)
     SELECT unnest($1::text[])
     ON CONFLICT (storage_path) DO NOTHING`,
    [paths]
  );
  return result.rowCount || 0;
}

/**
 * Delete a bounded batch. The queue row remains durable on filesystem errors;
 * an unlink that succeeded before a process crash is safely retried as ENOENT.
 */
export async function processPrivatePhotoPurgeBatch(pool, {
  storageRoot,
  batchSize = DEFAULT_PRIVATE_PHOTO_PURGE_BATCH_SIZE,
  unlinkFile
} = {}) {
  const limit = normalizePrivatePhotoPurgeBatchSize(batchSize);
  if (typeof unlinkFile !== 'function') throw new TypeError('unlinkFile is required');
  const candidates = await pool.query(
    `SELECT id FROM private_photo_purge_queue
     WHERE next_attempt_at <= statement_timestamp()
     ORDER BY next_attempt_at, created_at
     LIMIT $1`,
    [limit]
  );
  const summary = { scanned: candidates.rows.length, deleted: 0, retried: 0, failures: 0 };

  for (const candidate of candidates.rows) {
    let client;
    let releaseError;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT id, storage_path, attempts FROM private_photo_purge_queue WHERE id = $1 AND next_attempt_at <= statement_timestamp() FOR UPDATE SKIP LOCKED',
        [candidate.id]
      );
      const task = locked.rows[0];
      if (!task) {
        await client.query('COMMIT');
        continue;
      }

      try {
        const target = resolvePrivatePhotoPath(task.storage_path, storageRoot);
        try {
          await unlinkFile(target);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await client.query('DELETE FROM private_photo_purge_queue WHERE id = $1', [task.id]);
        await client.query('COMMIT');
        summary.deleted += 1;
      } catch (error) {
        const attempts = Number(task.attempts || 0) + 1;
        const delayMs = privatePhotoPurgeRetryDelayMs(attempts);
        const safeCode = /^[A-Z0-9_]{1,64}$/.test(String(error?.code || ''))
          ? String(error.code) : 'PHOTO_PURGE_FAILED';
        await client.query(
          `UPDATE private_photo_purge_queue
           SET attempts = $2,
               next_attempt_at = statement_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
               last_error_code = $4
           WHERE id = $1`,
          [task.id, attempts, delayMs, safeCode]
        );
        await client.query('COMMIT');
        summary.retried += 1;
        summary.failures += 1;
      }
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
      }
      if (releaseError) client?.release(releaseError);
      else client?.release();
      client = null;
      summary.failures += 1;
      continue;
    } finally {
      client?.release(releaseError);
    }
  }
  return summary;
}
