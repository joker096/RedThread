import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CANDIDATE_NAMES = Object.freeze({
  private_photo: new RegExp('^' + UUID + '\\.(?:jpg|png)$', 'i'),
  private_voice_intro: new RegExp('^' + UUID + '\\.enc$', 'i'),
  identity_l3_media: new RegExp('^' + UUID + '$', 'i')
});

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readPrivateRoot(root, queueName) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('privacy_recovery_physical_storage_root_missing:' + queueName);
  }
  const absolute = path.resolve(root);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new Error('privacy_recovery_physical_storage_root_unavailable:' + queueName);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('privacy_recovery_physical_storage_root_unsafe:' + queueName);
  }
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new Error('privacy_recovery_physical_storage_root_unavailable:' + queueName);
  }
  if (canonical !== absolute) {
    throw new Error('privacy_recovery_physical_storage_root_unsafe:' + queueName);
  }
  try {
    return await readdir(absolute, { withFileTypes: true });
  } catch {
    throw new Error('privacy_recovery_physical_storage_scan_failed:' + queueName);
  }
}

/**
 * Independently scans the three private storage roots and compares generated
 * object locators with the immutable SHA-256 purge obligations. It never reads
 * media contents, follows symlinks, or mutates storage. A missing/unreadable
 * root is a hard failure; an empty directory is valid only when no obligated
 * object is present there.
 *
 * Photo/voice obligations hash their absolute storage path. L3 obligations
 * hash the server-generated UUID object key (not its filesystem path).
 */
export async function verifyPhysicalPurgeAbsence({ obligations, storageRoots } = {}) {
  if (!Array.isArray(obligations)) {
    throw new TypeError('privacy_recovery_physical_obligations_invalid');
  }
  const grouped = new Map([
    ['private_photo', new Set()],
    ['private_voice_intro', new Set()],
    ['identity_l3_media', new Set()]
  ]);
  for (const obligation of obligations) {
    const target = grouped.get(obligation?.queue_name);
    if (!target || typeof obligation.storage_path_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(obligation.storage_path_sha256)) {
      throw new Error('privacy_recovery_physical_obligation_invalid');
    }
    target.add(obligation.storage_path_sha256);
  }

  const roots = storageRoots || {};
  for (const [queueName, expectedDigests] of grouped) {
    if (expectedDigests.size === 0) continue;
    const root = roots[queueName];
    const entries = await readPrivateRoot(root, queueName);
    const pattern = CANDIDATE_NAMES[queueName];
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      const locator = queueName === 'identity_l3_media'
        ? entry.name
        : path.join(path.resolve(root), entry.name);
      if (expectedDigests.has(digest(locator))) {
        // Do not follow or inspect the object: its directory entry alone proves
        // that the obligated object name is still present in the storage root.
        throw new Error('privacy_recovery_physical_object_still_exists:' + queueName);
      }
    }
  }

  return {
    complete: true,
    verifiedObjectCount: obligations.length
  };
}
