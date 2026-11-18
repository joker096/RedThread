import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const QUEUE_ROOTS = Object.freeze({
  private_photo: 'photo',
  private_voice_intro: 'voice',
  identity_l3_media: 'identityL3'
});

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function listRealDirectory(root, code) {
  if (typeof root !== 'string' || !root.trim()) throw new Error(code + '_root_required');
  const absolute = path.resolve(root);
  let info;
  try {
    info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
      throw new Error(code + '_root_unsafe');
    }
    return { absolute, entries: await readdir(absolute) };
  } catch (error) {
    if (error?.message === code + '_root_unsafe') throw error;
    throw new Error(code + '_storage_unavailable');
  }
}

/**
 * Independently checks the actual private-media directories after replay.
 * Obligations retain only SHA-256 path/key digests, so the verifier hashes
 * direct-child names without exposing paths or object keys in its report.
 * It is read-only and fails closed on missing roots or directory errors.
 */
export async function verifyPhysicalMediaAbsence({ obligations, roots }) {
  if (!Array.isArray(obligations) || !roots || typeof roots !== 'object') {
    throw new TypeError('privacy_recovery_physical_verification_input_invalid');
  }

  const grouped = new Map();
  for (const row of obligations) {
    const queue = row?.queue_name;
    const expectedDigest = row?.storage_path_sha256;
    if (!Object.hasOwn(QUEUE_ROOTS, queue) || typeof expectedDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error('privacy_recovery_physical_obligation_invalid');
    }
    if (!grouped.has(queue)) grouped.set(queue, new Set());
    grouped.get(queue).add(expectedDigest);
  }

  const verified = { private_photo: 0, private_voice_intro: 0, identity_l3_media: 0 };
  for (const [queue, expectedDigests] of grouped) {
    const rootKey = QUEUE_ROOTS[queue];
    const { absolute, entries } = await listRealDirectory(
      roots[rootKey],
      'privacy_recovery_physical_' + rootKey
    );
    const found = new Set();
    for (const name of entries) {
      const candidate = queue === 'identity_l3_media'
        ? name
        : path.join(absolute, name);
      const candidateDigest = digest(candidate);
      if (expectedDigests.has(candidateDigest)) found.add(candidateDigest);
    }
    if (found.size) {
      throw new Error('privacy_recovery_physical_media_still_exists');
    }
    verified[queue] = expectedDigests.size;
  }

  return {
    verifiedPhotoObjectAbsenceCount: verified.private_photo,
    verifiedVoiceObjectAbsenceCount: verified.private_voice_intro,
    verifiedIdentityL3ObjectAbsenceCount: verified.identity_l3_media
  };
}
