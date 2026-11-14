import 'dotenv/config';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  decryptVoiceIntro,
  encryptVoiceIntro,
  parseVoiceIntroEncryptionKeyring,
  resolvePrivateVoiceIntroPath
} from '../server/voiceIntroStorage.js';

const { Pool } = pg;
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024 + 128;

async function readRegularPrivateFile(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_CIPHERTEXT_BYTES) {
      throw new Error('voice_intro_file_not_regular_or_size_invalid');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function inspectVoiceIntroMigrationPreflight({
  pool,
  storageRoot,
  keyring
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('read_only_database_pool_required');
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') throw new TypeError('VOICE_INTRO_STORAGE_DIR is required');
  if (!keyring || !(keyring.keys instanceof Map) || !keyring.activeKeyId) {
    throw new TypeError('valid_versioned_voice_keyring_required');
  }

  const root = path.resolve(storageRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('voice_intro_storage_root_not_a_real_directory');
  }

  const client = await pool.connect();
  let refs;
  let queued;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    refs = (await client.query('SELECT storage_path FROM profile_voice_intros ORDER BY id')).rows;
    queued = (await client.query('SELECT storage_path FROM private_voice_intro_purge_queue ORDER BY id')).rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const queuedPaths = new Set(queued.map(row => row.storage_path));
  const seenPaths = new Set();
  const report = {
    mode: 'read_only_preflight',
    generatedAt: new Date().toISOString(),
    databaseReferences: refs.length,
    queuedForPurge: queued.length,
    legacyV1Authenticated: 0,
    versionedV2Authenticated: 0,
    stagedV2RoundTripsVerifiedInMemory: 0,
    alreadyQueuedReferences: 0,
    duplicateReferences: 0,
    failures: 0,
    databaseTransaction: 'repeatable_read_read_only',
    plaintextWrittenToDisk: false,
    ciphertextWrittenToDisk: false,
    databaseRowsChanged: false
  };

  for (const row of refs) {
    let target;
    try {
      target = resolvePrivateVoiceIntroPath(row.storage_path, root);
    } catch {
      report.failures += 1;
      continue;
    }
    if (seenPaths.has(target)) {
      report.duplicateReferences += 1;
      report.failures += 1;
      continue;
    }
    seenPaths.add(target);
    if (queuedPaths.has(row.storage_path)) {
      report.alreadyQueuedReferences += 1;
      report.failures += 1;
      continue;
    }

    let encrypted;
    let plaintext;
    let candidate;
    let verified;
    try {
      encrypted = await readRegularPrivateFile(target);
      const isV1 = encrypted.subarray(0, 9).equals(Buffer.from('VOWVOICE1'));
      const isV2 = encrypted.subarray(0, 9).equals(Buffer.from('VOWVOICE2'));
      if (!isV1 && !isV2) throw new Error('invalid_voice_intro_ciphertext');
      plaintext = decryptVoiceIntro(encrypted, keyring);
      if (isV1) report.legacyV1Authenticated += 1;
      else report.versionedV2Authenticated += 1;

      candidate = encryptVoiceIntro(plaintext, keyring);
      verified = decryptVoiceIntro(candidate, keyring);
      if (!verified.equals(plaintext)) throw new Error('voice_intro_round_trip_mismatch');
      report.stagedV2RoundTripsVerifiedInMemory += 1;
    } catch {
      report.failures += 1;
    } finally {
      plaintext?.fill(0);
      verified?.fill(0);
      candidate?.fill(0);
      encrypted?.fill(0);
    }
  }

  report.readyForSeparatelyApprovedMigration =
    report.failures === 0 &&
    report.duplicateReferences === 0 &&
    report.alreadyQueuedReferences === 0 &&
    report.stagedV2RoundTripsVerifiedInMemory === report.databaseReferences;
  return report;
}

export async function runVoiceIntroMigrationPreflight({
  databaseUrl = process.env.DATABASE_URL,
  storageRoot = process.env.VOICE_INTRO_STORAGE_DIR,
  keyring = parseVoiceIntroEncryptionKeyring()
} = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!keyring) throw new Error('VOICE_INTRO_KEYRING and VOICE_INTRO_ACTIVE_KEY_ID must define a valid keyring');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    return await inspectVoiceIntroMigrationPreflight({ pool, storageRoot, keyring });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVoiceIntroMigrationPreflight()
    .then(report => {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (!report.readyForSeparatelyApprovedMigration) process.exitCode = 2;
    })
    .catch(error => {
      process.stderr.write('Voice migration preflight failed: ' + (error?.message || 'unknown error') + '\n');
      process.exitCode = 1;
    });
}
