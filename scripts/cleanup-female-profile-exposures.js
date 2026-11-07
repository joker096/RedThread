import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
export const DEFAULT_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE = 1000;
const MAX_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE = 5000;

export function normalizeFemaleProfileExposureCleanupBatchSize(value = DEFAULT_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE) {
    throw new RangeError(
      `female profile exposure cleanup batch size must be an integer between 1 and ${MAX_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE}`
    );
  }
  return batchSize;
}

/**
 * Remove exposure rows from prior UTC calendar days in bounded batches.
 * The current UTC date is captured once per batch. SKIP LOCKED lets concurrent
 * discovery requests finish their own idempotent per-account cleanup without
 * making this global privacy worker wait on their row locks.
 */
export async function cleanupExpiredFemaleProfileExposures(pool, options = {}) {
  const batchSize = normalizeFemaleProfileExposureCleanupBatchSize(options.batchSize);
  let deleted = 0;
  let batchDeleted;

  do {
    const result = await pool.query(
      `WITH utc_day AS MATERIALIZED (
         SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS current_utc_date
       ),
       expired AS MATERIALIZED (
         SELECT exposure.user_id, exposure.profile_user_id, exposure.exposure_date
         FROM female_profile_exposures AS exposure
         CROSS JOIN utc_day
         WHERE exposure.exposure_date < utc_day.current_utc_date
         ORDER BY exposure.exposure_date, exposure.user_id, exposure.profile_user_id
         LIMIT $1
         FOR UPDATE OF exposure SKIP LOCKED
       )
       DELETE FROM female_profile_exposures AS exposures
       USING expired
       WHERE exposures.user_id = expired.user_id
         AND exposures.profile_user_id = expired.profile_user_id
         AND exposures.exposure_date = expired.exposure_date
       RETURNING exposures.user_id`,
      [batchSize]
    );
    batchDeleted = result.rowCount ?? result.rows?.length ?? 0;
    deleted += batchDeleted;
  } while (batchDeleted === batchSize);

  return deleted;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for female profile exposure cleanup');
  }

  const batchSize = normalizeFemaleProfileExposureCleanupBatchSize(
    process.env.FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE
      ? Number(process.env.FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE)
      : DEFAULT_FEMALE_PROFILE_EXPOSURE_CLEANUP_BATCH_SIZE
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });

  try {
    const deleted = await cleanupExpiredFemaleProfileExposures(pool, { batchSize });
    console.log(
      `Female profile exposure cleanup completed; deleted ${deleted} row(s) from prior UTC calendar days.`
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safeErrorCode = typeof error?.code === 'string' ? error.code : 'unexpected_error';
    console.error('Female profile exposure cleanup failed:', safeErrorCode);
    process.exitCode = 1;
  });
}
