import 'dotenv/config';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import pg from 'pg';
import { processPrivateVoiceIntroPurgeBatch } from './voiceIntroStorage.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for private voice intro purge');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const summary = await processPrivateVoiceIntroPurgeBatch(pool, {
    storageRoot: path.resolve(process.env.VOICE_INTRO_STORAGE_DIR || 'uploads/private-voice-intros'),
    batchSize: process.env.VOICE_INTRO_PURGE_BATCH_SIZE || 100,
    unlinkFile: unlink
  });
  console.log(JSON.stringify(summary));
  if (summary.failures > 0) process.exitCode = 2;
} finally {
  await pool.end();
}
