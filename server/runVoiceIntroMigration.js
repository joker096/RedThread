import { hostname } from 'node:os';
import pg from 'pg';
import { parseVoiceIntroEncryptionKeyring } from './voiceIntroStorage.js';
import { processNextVoiceIntroMigration } from './voiceIntroMigrationWorker.js';

const { Pool } = pg;

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(name + '_required');
  }
  return value.trim();
}

export async function runVoiceIntroMigrationOnce(env = process.env) {
  if (env.VOICE_INTRO_MIGRATION_ENABLED !== 'true') {
    throw new Error('voice_intro_migration_not_enabled');
  }
  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL');
  const storageRoot = required(env.VOICE_INTRO_STORAGE_DIR, 'VOICE_INTRO_STORAGE_DIR');
  const keyring = parseVoiceIntroEncryptionKeyring({
    keyringValue: env.VOICE_INTRO_KEYRING,
    activeKeyId: env.VOICE_INTRO_ACTIVE_KEY_ID,
    legacyKeyValue: env.VOICE_INTRO_ENCRYPTION_KEY
  });
  if (!keyring || !(keyring.keys instanceof Map) || keyring.keys.size < 1 ||
      !keyring.legacyKey || keyring.legacyKey.length !== 32) {
    throw new Error('versioned_voice_keyring_with_legacy_key_required');
  }
  const journalId = env.VOICE_INTRO_MIGRATION_JOURNAL_ID?.trim() || undefined;
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  try {
    return await processNextVoiceIntroMigration(pool, {
      workerId: (env.VOICE_INTRO_MIGRATION_WORKER_ID || `vow-migration-${hostname()}-${process.pid}`).slice(0, 128),
      journalId,
      storageRoot,
      keyring
    });
  } finally {
    for (const key of keyring.keys.values()) key.fill(0);
    keyring.legacyKey.fill(0);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.argv.includes('--apply')) {
    process.stderr.write('Refusing to run: pass --apply and set VOICE_INTRO_MIGRATION_ENABLED=true.\\n');
    process.exitCode = 2;
  } else {
    try {
      const result = await runVoiceIntroMigrationOnce();
      process.stdout.write(JSON.stringify(result) + '\\n');
    } catch (error) {
      process.stderr.write((error?.message || 'voice_intro_migration_failed') + '\\n');
      process.exitCode = 1;
    }
  }
}
