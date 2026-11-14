import path from 'node:path';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { VOICE_INTRO_CONSENT_VERSION } from './voiceIntroConsent.js';

const MAGIC = Buffer.from('VOWVOICE1');
const VERSIONED_MAGIC = Buffer.from('VOWVOICE2');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_DURATION_MS = 15_000;
const MAX_DURATION_MS = 25_000;
const ALLOWED_MIME_TYPES = new Set(['audio/mp4', 'audio/aac', 'audio/x-m4a']);

export function parseVoiceIntroEncryptionKey(value = process.env.VOICE_INTRO_ENCRYPTION_KEY) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}

// JSON map: {"key-id":"<64 hex chars>"}. Keep legacy key material separately
// until every VOWVOICE1 recording has been migrated and rollback is no longer needed.
export function parseVoiceIntroEncryptionKeyring({
  keyringValue = process.env.VOICE_INTRO_KEYRING,
  activeKeyId = process.env.VOICE_INTRO_ACTIVE_KEY_ID,
  legacyKeyValue = process.env.VOICE_INTRO_ENCRYPTION_KEY
} = {}) {
  const legacyKey = parseVoiceIntroEncryptionKey(legacyKeyValue);
  if (typeof keyringValue !== 'string' || keyringValue.trim() === '') return legacyKey;
  let parsed;
  try { parsed = JSON.parse(keyringValue); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 32 ||
      typeof activeKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(activeKeyId) ||
      !Object.hasOwn(parsed, activeKeyId)) return null;
  const keys = new Map();
  for (const [id, value] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
    keys.set(id, Buffer.from(value, 'hex'));
  }
  return { activeKeyId, keys, legacyKey };
}

function resolveVoiceIntroKey(key, keyId) {
  const resolved = key?.keys instanceof Map ? key.keys.get(keyId) : null;
  if (Buffer.isBuffer(resolved) && resolved.length === 32) return resolved;
  throw new Error('voice_intro_encryption_key_unavailable');
}

export function encryptVoiceIntro(input, key) {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > MAX_BYTES) throw new TypeError('invalid_voice_intro_buffer');
  if (Buffer.isBuffer(key)) {
    if (key.length !== 32) throw new TypeError('invalid_voice_intro_encryption_key');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }
  if (!key || !(key.keys instanceof Map) || !key.activeKeyId || !key.keys.has(key.activeKeyId)) throw new TypeError('invalid_voice_intro_encryption_keyring');
  const id = Buffer.from(key.activeKeyId, 'utf8');
  if (id.length < 1 || id.length > 64) throw new TypeError('invalid_voice_intro_key_id');
  const header = Buffer.concat([VERSIONED_MAGIC, Buffer.from([id.length]), id]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.keys.get(key.activeKeyId), iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptVoiceIntro(encrypted, key) {
  if (!Buffer.isBuffer(encrypted)) throw new Error('invalid_voice_intro_ciphertext');
  if (encrypted.subarray(0, VERSIONED_MAGIC.length).equals(VERSIONED_MAGIC)) {
    if (encrypted.length <= VERSIONED_MAGIC.length + 1 + IV_BYTES + TAG_BYTES) throw new Error('invalid_voice_intro_ciphertext');
    const idLength = encrypted[VERSIONED_MAGIC.length];
    const idStart = VERSIONED_MAGIC.length + 1;
    const idEnd = idStart + idLength;
    const ivStart = idEnd;
    const tagStart = ivStart + IV_BYTES;
    const bodyStart = tagStart + TAG_BYTES;
    if (idLength < 1 || idLength > 64 || bodyStart >= encrypted.length) throw new Error('invalid_voice_intro_ciphertext');
    const id = encrypted.subarray(idStart, idEnd).toString('utf8');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid_voice_intro_ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', resolveVoiceIntroKey(key, id), encrypted.subarray(ivStart, tagStart));
    decipher.setAAD(encrypted.subarray(0, idEnd));
    decipher.setAuthTag(encrypted.subarray(tagStart, bodyStart));
    try { return Buffer.concat([decipher.update(encrypted.subarray(bodyStart)), decipher.final()]); }
    catch { throw new Error('voice_intro_authentication_failed'); }
  }
  if (encrypted.length <= MAGIC.length + IV_BYTES + TAG_BYTES || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid_voice_intro_ciphertext');
  const legacyKey = Buffer.isBuffer(key) ? key : key?.legacyKey;
  if (!Buffer.isBuffer(legacyKey) || legacyKey.length !== 32) throw new Error('voice_intro_encryption_key_unavailable');
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const bodyStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', legacyKey, encrypted.subarray(ivStart, tagStart));
  decipher.setAuthTag(encrypted.subarray(tagStart, bodyStart));
  try { return Buffer.concat([decipher.update(encrypted.subarray(bodyStart)), decipher.final()]); }
  catch { throw new Error('voice_intro_authentication_failed'); }
}

/**
 * Validate every component of a private voice-intro storage root. When create is
 * enabled, create missing components one at a time only after validating their
 * parent; never let recursive mkdir traverse an untrusted symlink ancestor.
 */
export async function ensurePrivateVoiceIntroStorageRoot(storageRoot, { create = false, mode = 0o700 } = {}) {
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') {
    throw new TypeError('VOICE_INTRO_STORAGE_DIR_required');
  }
  const root = path.resolve(storageRoot);
  const parsed = path.parse(root);
  const segments = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('voice_intro_storage_root_not_private_directory');
  }
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      await mkdir(current, { mode });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('voice_intro_storage_root_not_private_directory');
    }
  }
  if (await realpath(root) !== root) {
    throw new Error('voice_intro_storage_root_not_private_directory');
  }
  if (create) await chmod(root, mode);
  return root;
}

export function resolvePrivateVoiceIntroPath(storagePath, storageRoot) {
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') throw new TypeError('voice intro storage root is not configured');
  if (typeof storagePath !== 'string' || storagePath.length < 1 || storagePath.length > 2048) throw new TypeError('voice intro storage path is invalid');
  const root = path.resolve(storageRoot);
  const resolved = path.resolve(storagePath);
  const relative = path.relative(root, resolved);
  const filename = path.basename(resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(resolved) !== root ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/i.test(filename)) {
    const error = new Error('voice intro storage path is outside the configured storage root');
    error.code = 'VOICE_INTRO_PATH_INVALID';
    throw error;
  }
  return resolved;
}

export async function validateVoiceIntro(input, mimeType, parser = parseBuffer) {
  if (!Buffer.isBuffer(input) || input.length < 64) throw new Error('invalid_voice_intro');
  if (input.length > MAX_BYTES) throw new Error('voice_intro_too_large');
  const normalizedMimeType = typeof mimeType === 'string' ? mimeType.split(';', 1)[0].trim().toLowerCase() : '';
  if (!ALLOWED_MIME_TYPES.has(normalizedMimeType)) throw new Error('unsupported_voice_intro_format');
  let metadata;
  try {
    metadata = await parser(input, { mimeType: normalizedMimeType }, { duration: true, skipCovers: true });
  } catch {
    throw new Error('invalid_voice_intro');
  }
  const codec = typeof metadata?.format?.codec === 'string' ? metadata.format.codec : '';
  const duration = Number(metadata?.format?.duration);
  if (!/aac/i.test(codec) || !Number.isFinite(duration) || duration <= 0) throw new Error('invalid_voice_intro_metadata');
  const durationMs = Math.round(duration * 1000);
  if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) throw new Error('voice_intro_duration_out_of_range');
  return { mimeType: normalizedMimeType, durationMs, byteSize: input.length };
}

export const VOICE_INTRO_LIMITS = Object.freeze({
  minDurationMs: MIN_DURATION_MS,
  maxDurationMs: MAX_DURATION_MS,
  maxBytes: MAX_BYTES,
  allowedMimeTypes: Object.freeze([...ALLOWED_MIME_TYPES])
});

export const DEFAULT_PRIVATE_VOICE_INTRO_PURGE_BATCH_SIZE = 100;
export const PRIVATE_VOICE_INTRO_PURGE_MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

export function normalizePrivateVoiceIntroPurgeBatchSize(value = DEFAULT_PRIVATE_VOICE_INTRO_PURGE_BATCH_SIZE) {
  const batchSize = Number(value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('private voice intro purge batch size must be an integer between 1 and 1000');
  }
  return batchSize;
}

export function privateVoiceIntroPurgeRetryDelayMs(attempts) {
  const count = Number(attempts);
  if (!Number.isInteger(count) || count < 0) throw new RangeError('attempts must be a non-negative integer');
  return Math.min(PRIVATE_VOICE_INTRO_PURGE_MAX_RETRY_DELAY_MS, 60_000 * (2 ** Math.min(count, 16)));
}

export async function queuePrivateVoiceIntroPurges(client, storagePaths) {
  const paths = [...new Set((Array.isArray(storagePaths) ? storagePaths : [])
    .map(value => typeof value === 'string' ? value : '')
    .filter(value => value.length > 0))];
  if (paths.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO private_voice_intro_purge_queue (storage_path)
     SELECT unnest($1::text[])
     ON CONFLICT (storage_path) DO NOTHING`,
    [paths]
  );
  return result.rowCount || 0;
}

export async function persistVoiceIntroReview(client, {
  voiceIntroId,
  ownerId,
  moderatorId,
  status,
  reason = null
}) {
  if (!['approved', 'rejected'].includes(status)) throw new TypeError('invalid_voice_intro_review_status');
  const result = await client.query(
    `UPDATE profile_voice_intros
     SET review_status = $2, reviewed_at = statement_timestamp(),
         reviewer_id = $3, review_reason = $4, updated_at = statement_timestamp()
     WHERE id = $1 AND user_id = $5 AND review_status = 'pending'
       AND EXISTS (SELECT 1 FROM users WHERE id = $5 AND status = 'active')
       AND EXISTS (
         SELECT 1 FROM profile_voice_intro_consents c
         WHERE c.user_id = $5 AND c.consent_version = $6 AND c.withdrawn_at IS NULL
       )
     RETURNING id, user_id AS "userId", storage_path AS "storagePath"`,
    [voiceIntroId, status, moderatorId, reason || null, ownerId, VOICE_INTRO_CONSENT_VERSION]
  );
  const reviewed = result.rows[0];
  if (!reviewed) return null;
  if (status === 'rejected') {
    await queuePrivateVoiceIntroPurges(client, [reviewed.storagePath]);
  }
  await client.query(
    'INSERT INTO moderation_audit_log (moderator_id, action, target_type, target_id, reason, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [moderatorId, 'voice_intro_' + status, 'profile_voice_intro', voiceIntroId, reason || null, JSON.stringify({ userId: ownerId })]
  );
  return { id: reviewed.id, userId: reviewed.userId, reviewStatus: status };
}

export async function processPrivateVoiceIntroPurgeBatch(pool, {
  storageRoot,
  batchSize = DEFAULT_PRIVATE_VOICE_INTRO_PURGE_BATCH_SIZE,
  unlinkFile
} = {}) {
  const limit = normalizePrivateVoiceIntroPurgeBatchSize(batchSize);
  if (typeof unlinkFile !== 'function') throw new TypeError('unlinkFile is required');
  const candidates = await pool.query(
    `SELECT id FROM private_voice_intro_purge_queue
     WHERE next_attempt_at <= statement_timestamp()
     ORDER BY next_attempt_at, created_at
     LIMIT $1`,
    [limit]
  );
  const summary = { scanned: candidates.rows.length, deleted: 0, retried: 0, failures: 0 };
  for (const candidate of candidates.rows) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT id, storage_path, attempts FROM private_voice_intro_purge_queue WHERE id = $1 AND next_attempt_at <= statement_timestamp() FOR UPDATE SKIP LOCKED',
        [candidate.id]
      );
      const task = locked.rows[0];
      if (!task) {
        await client.query('COMMIT');
        client.release();
        client = null;
        continue;
      }
      try {
        const target = resolvePrivateVoiceIntroPath(task.storage_path, storageRoot);
        try { await unlinkFile(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await client.query('DELETE FROM private_voice_intro_purge_queue WHERE id = $1', [task.id]);
        await client.query('COMMIT');
        summary.deleted += 1;
      } catch (error) {
        const attempts = Number(task.attempts || 0) + 1;
        const delayMs = privateVoiceIntroPurgeRetryDelayMs(attempts);
        const safeCode = /^[A-Z0-9_]{1,64}$/.test(String(error?.code || ''))
          ? String(error.code) : 'VOICE_INTRO_PURGE_FAILED';
        await client.query(
          `UPDATE private_voice_intro_purge_queue
           SET attempts = $2,
               next_attempt_at = statement_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
               last_error_code = $4
           WHERE id = $1`,
          [task.id, attempts, delayMs, safeCode]
        );
        await client.query('COMMIT');
        summary.retried += 1;
        summary.failures += 1;
      }
    } catch {
      if (client) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      summary.failures += 1;
    } finally {
      client?.release();
    }
  }
  return summary;
}
