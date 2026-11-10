import 'dotenv/config';
import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { processPrivateVoiceIntroPurgeBatch } from './voiceIntroStorage.js';

const { Pool } = pg;

export async function runPrivateVoiceIntroPurge({
  databaseUrl = process.env.DATABASE_URL,
  storageRoot = process.env.VOICE_INTRO_STORAGE_DIR,
  batchSize = process.env.VOICE_INTRO_PURGE_BATCH_SIZE || 100,
  pool: suppliedPool
} = {}) {
  if (!databaseUrl && !suppliedPool) throw new Error('DATABASE_URL is required');
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') {
    throw new Error('VOICE_INTRO_STORAGE_DIR is required; refusing to purge without the mounted private volume');
  }

  const resolvedStorageRoot = path.resolve(storageRoot);
  const storageInfo = await lstat(resolvedStorageRoot);
  if (!storageInfo.isDirectory() || storageInfo.isSymbolicLink()) {
    throw new Error('private voice introduction storage root is not a real directory');
  }

  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    return await processPrivateVoiceIntroPurgeBatch(pool, {
      storageRoot: resolvedStorageRoot,
      batchSize,
      unlinkFile: unlink
    });
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrivateVoiceIntroPurge()
    .then(summary => {
      console.log('Private voice introduction purge batch:', JSON.stringify(summary));
      if (summary.failures > 0) process.exitCode = 2;
    })
    .catch(error => {
      console.error('Private voice introduction purge failed:', error?.message || 'unknown error');
      process.exitCode = 1;
    });
}
