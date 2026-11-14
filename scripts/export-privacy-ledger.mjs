import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function hmacHex(secret, value) {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function validEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  return Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
    typeof event.event_id === 'string' &&
    Number.isSafeInteger(event.schema_version) &&
    typeof event.event_type === 'string' &&
    /^[a-f0-9]{64}$/i.test(event.subject_ref) &&
    (event.resource_ref === null || event.resource_ref === undefined || /^[a-f0-9]{64}$/i.test(event.resource_ref)) &&
    typeof event.occurred_at === 'string' && Number.isFinite(Date.parse(event.occurred_at)) &&
    typeof event.received_at === 'string' && Number.isFinite(Date.parse(event.received_at));
}

function signedHeaders(secret, timestamp, pathname) {
  return {
    'x-ledger-timestamp': timestamp,
    'x-ledger-signature': hmacHex(secret, timestamp + '.' + pathname)
  };
}

export async function fetchCompleteLedger({
  endpoint,
  authSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  pageSize = 200
}) {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash ||
      base.username || base.password || typeof authSecret !== 'string' || authSecret.length < 32 ||
      typeof fetchImpl !== 'function' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('privacy_ledger_export_configuration_invalid');
  }

  const events = [];
  let after = 0;
  let watermark = null;
  while (watermark === null || after < watermark) {
    const url = new URL('/v1/events', base);
    url.searchParams.set('after', String(after));
    url.searchParams.set('limit', String(pageSize));
    if (watermark !== null) url.searchParams.set('through', String(watermark));
    const timestamp = String(Math.floor(now() / 1000));
    const signedPath = 'GET\n' + url.pathname + url.search;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: signedHeaders(authSecret, timestamp, signedPath),
        cache: 'no-store',
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      throw new Error('privacy_ledger_export_fetch_failed');
    }
    if (!response?.ok) throw new Error('privacy_ledger_export_http_' + (response?.status ?? 'unknown'));
    let page;
    try { page = await response.json(); } catch { throw new Error('privacy_ledger_export_invalid_json'); }
    if (!page || !Array.isArray(page.events) || !Number.isSafeInteger(page.watermark) ||
        page.watermark < 0 || !Number.isSafeInteger(page.next_after) || page.next_after < after) {
      throw new Error('privacy_ledger_export_invalid_page');
    }
    if (watermark === null) watermark = page.watermark;
    if (page.watermark !== watermark) throw new Error('privacy_ledger_export_watermark_changed');
    if (page.events.length === 0 && after < watermark) throw new Error('privacy_ledger_export_page_gap');
    for (const event of page.events) {
      if (!validEvent(event) || event.sequence !== after + 1) {
        throw new Error('privacy_ledger_export_sequence_gap_or_invalid_event');
      }
      events.push(event);
      after = event.sequence;
    }
    if (page.next_after !== after) throw new Error('privacy_ledger_export_cursor_mismatch');
  }
  if (after !== watermark) throw new Error('privacy_ledger_export_incomplete');
  return { watermark, events };
}

function writeToChild(child, chunk) {
  return new Promise((resolve, reject) => {
    if (child.stdin.destroyed) return reject(new Error('age_input_closed'));
    if (child.stdin.write(chunk)) return resolve();
    child.stdin.once('drain', resolve);
    child.stdin.once('error', reject);
  });
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function writeEncryptedLedgerExport({
  endpoint = process.env.PRIVACY_RECOVERY_LEDGER_URL,
  authSecret = process.env.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET,
  recipient = process.env.PRIVACY_LEDGER_AGE_RECIPIENT,
  outputDirectory = process.env.PRIVACY_LEDGER_BACKUP_DIR || './backups/privacy-ledger',
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn,
  now = Date.now
} = {}) {
  if (typeof recipient !== 'string' || !recipient.startsWith('age1') ||
      typeof outputDirectory !== 'string' || !outputDirectory) {
    throw new Error('privacy_ledger_export_recipient_or_directory_missing');
  }
  const root = path.resolve(outputDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('privacy_ledger_export_directory_invalid');

  const { watermark, events } = await fetchCompleteLedger({ endpoint, authSecret, fetchImpl, now });
  const timestamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const fileName = 'vow-privacy-ledger-' + timestamp + '-seq-' + watermark + '.ndjson.age';
  const finalPath = path.join(root, fileName);
  const tempPath = finalPath + '.' + randomUUID() + '.tmp';
  const checksumPath = finalPath + '.sha256';
  const checksumTemp = checksumPath + '.' + randomUUID() + '.tmp';
  let child;
  try {
    child = spawnImpl('age', ['--encrypt', '--recipient', recipient, '--output', tempPath], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('age_encrypt_failed_' + code + ':' + stderr)));
    });
    const manifest = {
      record_type: 'vow_privacy_ledger_export',
      schema_version: 1,
      exported_at: new Date(now()).toISOString(),
      first_sequence: events.length ? events[0].sequence : 0,
      last_sequence: watermark,
      event_count: events.length
    };
    await writeToChild(child, JSON.stringify(manifest) + '\n');
    for (const event of events) await writeToChild(child, JSON.stringify(event) + '\n');
    await new Promise((resolve, reject) => {
      child.stdin.once('error', reject);
      child.stdin.end(resolve);
    });
    await closed;

    const archiveInfo = await lstat(tempPath);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size === 0) {
      throw new Error('privacy_ledger_export_archive_invalid');
    }
    const checksum = await sha256File(tempPath);
    await writeFile(checksumTemp, checksum + '  ' + fileName + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tempPath, finalPath);
    await rename(checksumTemp, checksumPath);
    return { archive: finalPath, checksum: checksumPath, sha256: checksum, watermark, eventCount: events.length };
  } catch (error) {
    child?.stdin?.destroy();
    await Promise.all([rm(tempPath, { force: true }), rm(checksumTemp, { force: true })]);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeEncryptedLedgerExport()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error('Privacy ledger export failed:', error?.message || 'unknown error');
      process.exitCode = 1;
    });
}
