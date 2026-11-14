import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EVENT_TYPES = new Set([
  'account_erasure_requested',
  'voice_intro_consent_withdrawn',
  'voice_intro_erasure_requested',
  'private_photo_erasure_requested',
  'identity_l3_consent_withdrawn',
  'ad_consent_revoked',
  'gift_order_consent_withdrawn'
]);

function validEvent(event, expectedSequence) {
  return Boolean(event && typeof event === 'object' && !Array.isArray(event) &&
    event.sequence === expectedSequence &&
    typeof event.event_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) &&
    event.schema_version === 1 &&
    EVENT_TYPES.has(event.event_type) &&
    typeof event.subject_ref === 'string' && /^[a-f0-9]{64}$/i.test(event.subject_ref) &&
    (event.resource_ref === null || event.resource_ref === undefined ||
      (typeof event.resource_ref === 'string' && /^[a-f0-9]{64}$/i.test(event.resource_ref))) &&
    typeof event.occurred_at === 'string' && Number.isFinite(Date.parse(event.occurred_at)) &&
    typeof event.received_at === 'string' && Number.isFinite(Date.parse(event.received_at)));
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyLedgerExportStream(stream) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let manifest = null;
  let expectedSequence = 1;
  let eventCount = 0;
  const eventIds = new Set();

  for await (const line of lines) {
    if (!line.trim()) throw new Error('privacy_ledger_archive_blank_line');
    let record;
    try { record = JSON.parse(line); } catch { throw new Error('privacy_ledger_archive_invalid_json'); }
    if (manifest === null) {
      if (!record || record.record_type !== 'vow_privacy_ledger_export' ||
          record.schema_version !== 1 || !Number.isSafeInteger(record.first_sequence) ||
          !Number.isSafeInteger(record.last_sequence) || !Number.isSafeInteger(record.event_count) ||
          record.first_sequence !== (record.event_count === 0 ? 0 : 1) ||
          record.last_sequence < 0 || record.event_count < 0 ||
          record.last_sequence !== record.event_count ||
          typeof record.exported_at !== 'string' || !Number.isFinite(Date.parse(record.exported_at))) {
        throw new Error('privacy_ledger_archive_manifest_invalid');
      }
      manifest = record;
      continue;
    }
    if (!validEvent(record, expectedSequence) || eventIds.has(record.event_id)) {
      throw new Error('privacy_ledger_archive_event_invalid_or_duplicate');
    }
    eventIds.add(record.event_id);
    expectedSequence += 1;
    eventCount += 1;
    if (eventCount > manifest.event_count) throw new Error('privacy_ledger_archive_event_count_exceeded');
  }

  if (!manifest) throw new Error('privacy_ledger_archive_manifest_missing');
  if (eventCount !== manifest.event_count || expectedSequence - 1 !== manifest.last_sequence) {
    throw new Error('privacy_ledger_archive_incomplete');
  }
  return {
    firstSequence: manifest.first_sequence,
    lastSequence: manifest.last_sequence,
    eventCount,
    exportedAt: manifest.exported_at
  };
}

export async function verifyEncryptedLedgerExport({
  archivePath,
  identityFile,
  spawnImpl = nodeSpawn
}) {
  if (typeof archivePath !== 'string' || !archivePath || typeof identityFile !== 'string' || !identityFile) {
    throw new Error('privacy_ledger_verify_configuration_missing');
  }
  const archive = path.resolve(archivePath);
  const identity = path.resolve(identityFile);
  const checksumPath = archive + '.sha256';
  const [archiveInfo, identityInfo, checksumInfo] = await Promise.all([
    lstat(archive), lstat(identity), lstat(checksumPath)
  ]);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size === 0 ||
      !identityInfo.isFile() || identityInfo.isSymbolicLink() ||
      !checksumInfo.isFile() || checksumInfo.isSymbolicLink()) {
    throw new Error('privacy_ledger_verify_input_invalid');
  }

  const sidecar = await readFile(checksumPath, 'utf8');
  const match = sidecar.match(/^([a-f0-9]{64})  ([^\\r\\n]+)\\n?$/i);
  if (!match || match[2] !== path.basename(archive)) throw new Error('privacy_ledger_verify_checksum_format_invalid');
  const actualHash = await sha256File(archive);
  if (actualHash.toLowerCase() !== match[1].toLowerCase()) throw new Error('privacy_ledger_verify_checksum_mismatch');

  const child = spawnImpl('age', ['--decrypt', '--identity', identity, archive], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error('privacy_ledger_age_decrypt_failed_' + code + ':' + stderr)));
  });

  let summary;
  try {
    summary = await verifyLedgerExportStream(child.stdout);
    await closed;
  } catch (error) {
    child.kill?.();
    throw error;
  }
  return { ...summary, sha256: actualHash, archive };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const archivePath = process.argv[2];
  const identityFile = process.env.PRIVACY_LEDGER_AGE_IDENTITY_FILE;
  verifyEncryptedLedgerExport({ archivePath, identityFile })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error('Privacy ledger verification failed:', error?.message || 'unknown error');
      process.exitCode = 1;
    });
}
