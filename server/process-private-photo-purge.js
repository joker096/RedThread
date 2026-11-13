import 'dotenv/config';
import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { processPrivatePhotoPurgeBatch } from './photoPurge.js';

const { Pool } = pg;

export function privatePhotoPurgeExitCode(summary) {
  return Number(summary?.failures || 0) > 0 ? 2 : 0;
}

export async function runPrivatePhotoPurge({
  databaseUrl = process.env.DATABASE_URL,
  storageRoot = process.env.PHOTO_STORAGE_DIR || 'uploads/private-photos',
  batchSize = process.env.PRIVATE_PHOTO_PURGE_BATCH_SIZE || 100,
  pool: suppliedPool
} = {}) {
  if (!databaseUrl && !suppliedPool) throw new Error('DATABASE_URL is required');
  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const resolvedStorageRoot = path.resolve(storageRoot);
    const rootInfo = await lstat(resolvedStorageRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('private photo storage root is not a real directory');
    }
    return await processPrivatePhotoPurgeBatch(pool, {
      storageRoot: resolvedStorageRoot,
      batchSize,
      unlinkFile: unlink
    });
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrivatePhotoPurge()
    .then(summary => {
      console.log('Private photo purge batch:', JSON.stringify(summary));
      process.exitCode = privatePhotoPurgeExitCode(summary);
    })
    .catch(error => {
      console.error('Private photo purge failed:', error?.message || 'unknown error');
      process.exitCode = 1;
    });
}
