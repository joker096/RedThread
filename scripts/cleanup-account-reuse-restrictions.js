import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
export const DEFAULT_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE = 500;
const MAX_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE = 5000;

export function normalizeAccountReuseCleanupBatchSize(value = DEFAULT_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE) {
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE) {
    throw new RangeError(`account reuse cleanup batch size must be an integer between 1 and ${MAX_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE}`);
  }
  return size;
}

export async function cleanupExpiredAccountReuseRestrictions(pool, options = {}) {
  const batchSize = normalizeAccountReuseCleanupBatchSize(options.batchSize);
  let deleted = 0;
  let batchDeleted;
  do {
    const result = await pool.query(
      `WITH expired AS MATERIALIZED (
         SELECT email_hmac
         FROM account_reuse_restrictions
         WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at, email_hmac
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM account_reuse_restrictions AS restrictions
       USING expired
       WHERE restrictions.email_hmac = expired.email_hmac
       RETURNING restrictions.email_hmac`,
      [batchSize]
    );
    batchDeleted = result.rowCount ?? result.rows?.length ?? 0;
    deleted += batchDeleted;
  } while (batchDeleted === batchSize);
  return deleted;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for account reuse restriction cleanup');
  const batchSize = normalizeAccountReuseCleanupBatchSize(
    process.env.ACCOUNT_REUSE_CLEANUP_BATCH_SIZE
      ? Number(process.env.ACCOUNT_REUSE_CLEANUP_BATCH_SIZE)
      : DEFAULT_ACCOUNT_REUSE_CLEANUP_BATCH_SIZE
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const deleted = await cleanupExpiredAccountReuseRestrictions(pool, { batchSize });
    console.log(`Account reuse restriction cleanup completed; deleted ${deleted} expired row(s).`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safeErrorCode = typeof error?.code === 'string' ? error.code : 'unexpected_error';
    console.error('Account reuse restriction cleanup failed:', safeErrorCode);
    process.exitCode = 1;
  });
}
