import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const L3_TEMPORARY_NAME = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_NAMES = Object.freeze({
  private_photo: new RegExp('^' + UUID + '\\.(?:jpg|png)$', 'i'),
  private_voice_intro: new RegExp('^' + UUID + '\\.enc$', 'i'),
  identity_l3_media: new RegExp('^' + UUID + '$', 'i')
});

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Open every path component relative to the previously opened directory
 * descriptor. O_NOFOLLOW applies to each component, not just the final root.
 * This prevents a symlinked/replaced parent component from redirecting the
 * attestation scan. The final descriptor pins the directory during readdir.
 */
async function readPrivateRoot(root, queueName) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('privacy_recovery_physical_storage_root_missing:' + queueName);
  }
  if (process.platform !== 'linux' ||
      typeof fsConstants.O_DIRECTORY !== 'number' ||
      typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new Error('privacy_recovery_physical_storage_descriptor_scan_unsupported:' + queueName);
  }

  const absolute = path.resolve(root);
  let before;
  try {
    before = await lstat(absolute);
  } catch {
    throw new Error('privacy_recovery_physical_storage_root_unavailable:' + queueName);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('privacy_recovery_physical_storage_root_unsafe:' + queueName);
  }

  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY |
    fsConstants.O_NOFOLLOW | (fsConstants.O_CLOEXEC || 0);
  let parent;
  let handle;
  try {
    parent = await open(path.parse(absolute).root, flags);
    const components = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
    for (const component of components) {
      let child;
      try {
        child = await open('/proc/self/fd/' + parent.fd + '/' + component, flags);
      } catch (error) {
        if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
          throw new Error('privacy_recovery_physical_storage_root_unsafe:' + queueName);
        }
        throw error;
      }
      await parent.close();
      parent = child;
    }

    handle = parent;
    parent = null;
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('privacy_recovery_physical_storage_root_changed:' + queueName);
    }
    try {
      return await readdir('/proc/self/fd/' + handle.fd, { withFileTypes: true });
    } catch {
      throw new Error('privacy_recovery_physical_storage_scan_failed:' + queueName);
    }
  } catch (error) {
    if (String(error?.message || '').startsWith('privacy_recovery_')) throw error;
    throw new Error('privacy_recovery_physical_storage_root_unavailable:' + queueName);
  } finally {
    await handle?.close().catch(() => {});
    await parent?.close().catch(() => {});
  }
}

/**
 * Compare generated object locators with immutable SHA-256 purge obligations.
 * This read-only attestation checks directory-entry absence only; it does not
 * inspect media bytes, snapshots, replicas, backups, or physical block reuse.
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
    if (!obligation || typeof obligation !== 'object' || Array.isArray(obligation) ||
        !target || typeof obligation.storage_path_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(obligation.storage_path_sha256)) {
      throw new Error('privacy_recovery_physical_obligation_invalid');
    }
    target.add(obligation.storage_path_sha256);
  }

  const roots = storageRoots || {};
  for (const [queueName, expectedDigests] of grouped) {
    const root = roots[queueName];
    // Scan every configured root, even when its obligation set is empty.
    // If obligations exist, a missing root is always a hard failure.
    if (expectedDigests.size === 0 && (typeof root !== 'string' || !root.trim())) continue;

    const entries = await readPrivateRoot(root, queueName);
    const pattern = CANDIDATE_NAMES[queueName];
    for (const entry of entries) {
      if (queueName === 'identity_l3_media' && L3_TEMPORARY_NAME.test(entry.name)) {
        throw new Error('privacy_recovery_physical_temporary_object_remains:identity_l3_media');
      }
      if (!pattern.test(entry.name)) continue;
      const locator = queueName === 'identity_l3_media'
        ? entry.name
        : path.join(path.resolve(root), entry.name);
      if (expectedDigests.has(digest(locator))) {
        throw new Error('privacy_recovery_physical_object_still_exists:' + queueName);
      }
    }
  }

  return {
    complete: true,
    verifiedObjectCount: obligations.length
  };
}
