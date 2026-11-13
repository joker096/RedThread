import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import {
  decryptVoiceIntro,
  encryptVoiceIntro,
  resolvePrivateVoiceIntroPath
} from './voiceIntroStorage.js';

const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024 + 128;
const V1_MAGIC = Buffer.from('VOWVOICE1');
const V2_MAGIC = Buffer.from('VOWVOICE2');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function assertPrivateRoot(storageRoot) {
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') {
    throw new TypeError('VOICE_INTRO_STORAGE_DIR_required');
  }
  const root = path.resolve(storageRoot);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('voice_intro_storage_root_not_private_directory');
  }
  return root;
}

async function readRegularCiphertext(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_CIPHERTEXT_BYTES) {
      throw new Error('voice_intro_ciphertext_file_invalid');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function assertCiphertextFormat(ciphertext, expectedFormat) {
  const actual = ciphertext.subarray(0, 9).equals(V1_MAGIC)
    ? 'VOWVOICE1'
    : ciphertext.subarray(0, 9).equals(V2_MAGIC) ? 'VOWVOICE2' : null;
  if (!actual || actual !== expectedFormat) throw new Error('voice_intro_ciphertext_format_mismatch');
}

export async function authenticateVoiceIntroMigrationSource({
  storageRoot,
  sourcePath,
  sourceSha256,
  sourceFormat,
  keyring
} = {}) {
  const root = await assertPrivateRoot(storageRoot);
  const source = resolvePrivateVoiceIntroPath(sourcePath, root);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256 || '')) throw new TypeError('source_sha256_invalid');
  const ciphertext = await readRegularCiphertext(source);
  try {
    if (sha256(ciphertext) !== sourceSha256) throw new Error('voice_intro_source_checksum_mismatch');
    assertCiphertextFormat(ciphertext, sourceFormat);
    const plaintext = decryptVoiceIntro(ciphertext, keyring);
    return { plaintext, sourceCiphertextSha256: sourceSha256 };
  } finally {
    ciphertext.fill(0);
  }
}

/**
 * Write/reuse a deterministic per-journal staged ciphertext. O_EXCL plus
 * O_NOFOLLOW prevents overwriting another artifact or following a symlink.
 * A retry after a crash authenticates the existing artifact instead.
 */
export async function stageVoiceIntroMigrationCiphertext({
  storageRoot,
  journalId,
  sourcePath,
  plaintext,
  targetKeyId,
  keyring
} = {}) {
  const root = await assertPrivateRoot(storageRoot);
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > 2 * 1024 * 1024) {
    throw new TypeError('voice_intro_plaintext_invalid');
  }
  if (typeof targetKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(targetKeyId) ||
      !(keyring?.keys instanceof Map) || !keyring.keys.has(targetKeyId)) {
    throw new Error('voice_intro_target_key_unavailable');
  }
  const stagedPath = resolvePrivateVoiceIntroPath(path.join(root, journalId + '.enc'), root);
  if (path.resolve(sourcePath) === stagedPath) throw new Error('voice_intro_stage_equals_source');

  const targetKeyring = { ...keyring, activeKeyId: targetKeyId };
  let ciphertext;
  let verified;
  try {
    ciphertext = encryptVoiceIntro(plaintext, targetKeyring);
    verified = decryptVoiceIntro(ciphertext, targetKeyring);
    if (!verified.equals(plaintext)) throw new Error('voice_intro_staged_round_trip_mismatch');

    let stagedCiphertext;
    try {
      const handle = await open(stagedPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        0o600);
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0) {
          throw new Error('voice_intro_stage_permissions_invalid');
        }
      } finally {
        await handle.close();
      }
      const directory = await open(root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      stagedCiphertext = await readRegularCiphertext(stagedPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      stagedCiphertext = await readRegularCiphertext(stagedPath);
    }

    try {
      const stagedPlaintext = decryptVoiceIntro(stagedCiphertext, keyring);
      try {
        if (!stagedPlaintext.equals(plaintext)) throw new Error('voice_intro_existing_stage_content_mismatch');
      } finally {
        stagedPlaintext.fill(0);
      }
      const stagedFormat = stagedCiphertext.subarray(0, 9).equals(V2_MAGIC) ? 'VOWVOICE2' : null;
      if (stagedFormat !== 'VOWVOICE2') throw new Error('voice_intro_stage_format_invalid');
      return { stagedPath, stagedSha256: sha256(stagedCiphertext) };
    } finally {
      stagedCiphertext.fill(0);
    }
  } finally {
    ciphertext?.fill(0);
    verified?.fill(0);
  }
}

export async function verifyVoiceIntroMigrationStage({
  storageRoot,
  stagedPath,
  stagedSha256,
  plaintext,
  keyring,
  targetKeyId
} = {}) {
  const root = await assertPrivateRoot(storageRoot);
  const staged = resolvePrivateVoiceIntroPath(stagedPath, root);
  const ciphertext = await readRegularCiphertext(staged);
  try {
    if (sha256(ciphertext) !== stagedSha256) throw new Error('voice_intro_stage_checksum_mismatch');
    if (!ciphertext.subarray(0, 9).equals(V2_MAGIC)) throw new Error('voice_intro_stage_format_invalid');
    const idLength = ciphertext[V2_MAGIC.length];
    const actualKeyId = ciphertext.subarray(V2_MAGIC.length + 1, V2_MAGIC.length + 1 + idLength).toString('utf8');
    if (actualKeyId !== targetKeyId) throw new Error('voice_intro_stage_key_id_mismatch');
    const decrypted = decryptVoiceIntro(ciphertext, keyring);
    try {
      if (Buffer.isBuffer(plaintext) && !decrypted.equals(plaintext)) {
        throw new Error('voice_intro_stage_plaintext_mismatch');
      }
    } finally {
      decrypted.fill(0);
    }
    return { stagedPath: staged, stagedSha256 };
  } finally {
    ciphertext.fill(0);
  }
}
