import 'dotenv/config';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { resolvePrivateVoiceIntroPath } from '../server/voiceIntroStorage.js';

const { Pool } = pg;
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/i;
const LEGACY_MAGIC = Buffer.from('VOWVOICE1');
const VERSIONED_MAGIC = Buffer.from('VOWVOICE2');

function emptyCounts() {
  return {
    databaseReferences: 0,
    queuedForPurge: 0,
    filesOnDisk: 0,
    legacyV1: 0,
    versionedV2: 0,
    versionedByKeyId: {},
    missingReferencedFiles: 0,
    missingQueuedFiles: 0,
    symlinkOrUnsafePaths: 0,
    malformedCiphertext: 0,
    orphanFiles: 0,
    filesAlsoQueuedForPurge: 0,
    unexpectedEntries: 0
  };
}

function classifyEnvelope(buffer, report) {
  if (buffer.length <= LEGACY_MAGIC.length + 12 + 16) {
    report.malformedCiphertext += 1;
    return;
  }
  if (buffer.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
    report.legacyV1 += 1;
    return;
  }
  if (!buffer.subarray(0, VERSIONED_MAGIC.length).equals(VERSIONED_MAGIC)) {
    report.malformedCiphertext += 1;
    return;
  }
  const idLength = buffer[VERSIONED_MAGIC.length];
  const idStart = VERSIONED_MAGIC.length + 1;
  const idEnd = idStart + idLength;
  const minimumLength = idEnd + 12 + 16 + 1;
  if (idLength < 1 || idLength > 64 || buffer.length < minimumLength) {
    report.malformedCiphertext += 1;
    return;
  }
  const keyId = buffer.subarray(idStart, idEnd).toString('utf8');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
    report.malformedCiphertext += 1;
    return;
  }
  report.versionedV2 += 1;
  report.versionedByKeyId[keyId] = (report.versionedByKeyId[keyId] || 0) + 1;
}

async function inspectPath(storagePath, storageRoot, diskNames, unsafeNames, report, missingCounter) {
  let target;
  try {
    target = resolvePrivateVoiceIntroPath(storagePath, storageRoot);
  } catch {
    report.symlinkOrUnsafePaths += 1;
    return;
  }
  const name = path.basename(target);
  if (!diskNames.has(name)) {
    report[missingCounter] += 1;
    return;
  }
  let info;
  try { info = await lstat(target); }
  catch { report[missingCounter] += 1; return; }
  if (info.isSymbolicLink() || !info.isFile()) {\n    if (!unsafeNames.has(name)) { unsafeNames.add(name); report.symlinkOrUnsafePaths += 1; }\n  }
}

export async function inspectVoiceIntroInventory({ pool, storageRoot } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('read_only_database_pool_required');
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') throw new TypeError('VOICE_INTRO_STORAGE_DIR is required');
  const root = path.resolve(storageRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('voice_intro_storage_root_not_a_real_directory');

  const entries = await readdir(root, { withFileTypes: true });
  const diskNames = new Set();
  const report = emptyCounts();
  for (const entry of entries) {
    if (!UUID_FILE.test(entry.name)) {
      report.unexpectedEntries += 1;
      continue;
    }
    diskNames.add(entry.name);
    report.filesOnDisk += 1;
    const filePath = path.join(root, entry.name);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      report.symlinkOrUnsafePaths += 1;
      continue;
    }
    // Read only the envelope prefix, never decrypt or emit audio content.
    const { open } = await import('node:fs/promises');
    const handle = await open(filePath, 'r');
    try {
      const prefix = Buffer.alloc(Math.min(info.size, VERSIONED_MAGIC.length + 1 + 64 + 12 + 16 + 1));
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      classifyEnvelope(prefix.subarray(0, bytesRead), report);
    } finally {
      await handle.close();
    }
  }

  const client = await pool.connect();
  let rows;
  let queueRows;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const refs = await client.query(
      'SELECT storage_path FROM profile_voice_intros ORDER BY id'
    );
    const queued = await client.query(
      'SELECT storage_path FROM private_voice_intro_purge_queue ORDER BY id'
    );
    rows = refs.rows;
    queueRows = queued.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  report.databaseReferences = rows.length;
  report.queuedForPurge = queueRows.length;
  const referencedNames = new Set();
  const queuedNames = new Set();
  for (const row of rows) {
    try { referencedNames.add(path.basename(resolvePrivateVoiceIntroPath(row.storage_path, root))); }
    catch { /* counted by inspectPath below */ }
    await inspectPath(row.storage_path, root, diskNames, unsafeNames, report, 'missingReferencedFiles');
  }
  for (const row of queueRows) {
    try { queuedNames.add(path.basename(resolvePrivateVoiceIntroPath(row.storage_path, root))); }
    catch { /* counted by inspectPath below */ }
    await inspectPath(row.storage_path, root, diskNames, unsafeNames, report, 'missingQueuedFiles');
  }
  for (const name of queuedNames) if (referencedNames.has(name)) report.filesAlsoQueuedForPurge += 1;
  for (const name of diskNames) {
    if (!referencedNames.has(name) && !queuedNames.has(name)) report.orphanFiles += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: 'read_only',
    decryptionPerformed: false,
    audioBytesWritten: false,
    databaseTransaction: 'repeatable_read_read_only',
    counts: report,
    nextStep: 'Review discrepancies and retention/deletion state before any migration; this report never changes database rows or files.'
  };
}

export async function runVoiceIntroInventory({
  databaseUrl = process.env.DATABASE_URL,
  storageRoot = process.env.VOICE_INTRO_STORAGE_DIR,
  pool: suppliedPool
} = {}) {
  if (!databaseUrl && !suppliedPool) throw new Error('DATABASE_URL is required');
  if (!storageRoot) throw new Error('VOICE_INTRO_STORAGE_DIR is required');
  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    return await inspectVoiceIntroInventory({ pool, storageRoot });
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVoiceIntroInventory()
    .then(report => {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.counts.missingReferencedFiles || report.counts.missingQueuedFiles ||
          report.counts.symlinkOrUnsafePaths || report.counts.malformedCiphertext) process.exitCode = 2;
    })
    .catch(error => {
      process.stderr.write('Voice introduction inventory failed: ' + (error?.message || 'unknown error') + '\n');
      process.exitCode = 1;
    });
}
