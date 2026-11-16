import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { processIdentityL3MediaPurgeBatch } from './identityL3MediaPurgeWorker.js';

const { Pool } = pg;

export async function runIdentityL3MediaPurge({
  databaseUrl = process.env.DATABASE_URL,
  storageRoot = process.env.IDENTITY_L3_STORAGE_DIR,
  batchSize = process.env.IDENTITY_L3_PURGE_BATCH_SIZE || 100,
  requireMount = process.env.IDENTITY_L3_REQUIRE_MOUNT === 'true',
  pool: suppliedPool
} = {}) {
  if (!databaseUrl && !suppliedPool) throw new Error('DATABASE_URL is required');
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') {
    throw new Error('IDENTITY_L3_STORAGE_DIR is required; refusing to purge without the encrypted media volume');
  }
  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    return await processIdentityL3MediaPurgeBatch(pool, {
      storageRoot,
      batchSize,
      requireMount
    });
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIdentityL3MediaPurge()
    .then(summary => {
      process.stdout.write('Identity L3 media purge batch: ' + JSON.stringify(summary) + '\n');
      if (summary.failures > 0) process.exitCode = 2;
    })
    .catch(error => {
      process.stderr.write('Identity L3 media purge failed: ' + (error?.message || 'unknown error') + '\n');
      process.exitCode = 1;
    });
}
