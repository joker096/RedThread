import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
export const AD_EVENT_RETENTION_DAYS = 90;
export const DEFAULT_AD_EVENT_CLEANUP_BATCH_SIZE = 1000;
const MAX_AD_EVENT_CLEANUP_BATCH_SIZE = 5000;

export function normalizeCleanupOptions({ retentionDays = AD_EVENT_RETENTION_DAYS, batchSize = DEFAULT_AD_EVENT_CLEANUP_BATCH_SIZE } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new RangeError('retentionDays must be an integer between 1 and 365');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_AD_EVENT_CLEANUP_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_AD_EVENT_CLEANUP_BATCH_SIZE}`);
  }
  return { retentionDays, batchSize };
}

export async function cleanupExpiredAdEvents(pool, options = {}) {
  const { retentionDays, batchSize } = normalizeCleanupOptions(options);
  let deleted = 0;
  let batchDeleted;

  do {
    const result = await pool.query(
      `WITH expired AS (
         SELECT event_id
         FROM ad_events
         WHERE created_at < NOW() - make_interval(days => $1)
         ORDER BY created_at, event_id
         LIMIT $2
       )
       DELETE FROM ad_events AS events
       USING expired
       WHERE events.event_id = expired.event_id
       RETURNING events.event_id`,
      [retentionDays, batchSize]
    );
    batchDeleted = result.rowCount ?? result.rows?.length ?? 0;
    deleted += batchDeleted;
  } while (batchDeleted === batchSize);

  return deleted;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run ad-event retention cleanup');
  }

  const { batchSize } = normalizeCleanupOptions({
    batchSize: process.env.AD_EVENT_CLEANUP_BATCH_SIZE
      ? Number(process.env.AD_EVENT_CLEANUP_BATCH_SIZE)
      : DEFAULT_AD_EVENT_CLEANUP_BATCH_SIZE
  });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });

  try {
    const deleted = await cleanupExpiredAdEvents(pool, { batchSize });
    console.log(`Ad-event retention cleanup completed; deleted ${deleted} event(s) older than ${AD_EVENT_RETENTION_DAYS} days.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Ad-event retention cleanup failed:', error.message);
    process.exitCode = 1;
  });
}
