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

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function assertRestoreRoot(root) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('privacy_recovery_physical_restore_root_required');
  }
  const absolute = path.resolve(root);
  try {
    const info = await lstat(absolute);
    const marker = path.join(absolute, '.vow-restore-pending');
    const markerInfo = await lstat(marker);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute ||
        !markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      throw new Error('privacy_recovery_physical_restore_root_unsafe');
    }
  } catch (error) {
    if (error?.message === 'privacy_recovery_physical_restore_root_unsafe') throw error;
    throw new Error('privacy_recovery_physical_restore_root_unavailable');
  }
  return absolute;
}

async function listRealDirectory(root, restoreRoot, code) {
  if (typeof root !== 'string' || !root.trim()) throw new Error(code + '_root_required');
  const absolute = path.resolve(root);
  if (!isWithin(restoreRoot, absolute)) throw new Error(code + '_root_outside_restore');
  try {
    const info = await lstat(absolute);
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
 * Photo/voice filenames are derived from the immutable replay resource UUID;
 * L3 filenames are matched against the object-key digest in the obligation.
 * It is read-only, scoped to the pending restore tree, and fails closed.
 */
export async function verifyPhysicalMediaAbsence({ obligations, effects, roots }) {
  if (!Array.isArray(obligations) || !Array.isArray(effects) ||
      !roots || typeof roots !== 'object') {
    throw new TypeError('privacy_recovery_physical_verification_input_invalid');
  }
  if (!obligations.length) {
    return {
      verifiedPhotoObjectAbsenceCount: 0,
      verifiedVoiceObjectAbsenceCount: 0,
      verifiedIdentityL3ObjectAbsenceCount: 0
    };
  }

  const restoreRoot = await assertRestoreRoot(roots.restoreRoot);
  const effectsBySequence = new Map(effects.map(effect => [String(effect.ledger_sequence), effect]));
  const grouped = new Map();
  for (const row of obligations) {
    const queue = row?.queue_name;
    const expectedDigest = row?.storage_path_sha256;
    if (!Object.hasOwn(QUEUE_ROOTS, queue) || typeof expectedDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error('privacy_recovery_physical_obligation_invalid');
    }
    const effect = effectsBySequence.get(String(row.ledger_sequence));
    if (!effect) throw new Error('privacy_recovery_physical_effect_missing');
    if (queue !== 'identity_l3_media' &&
        (typeof effect.resource_id !== 'string' ||
         !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(effect.resource_id))) {
      throw new Error('privacy_recovery_physical_resource_id_missing');
    }
    if (!grouped.has(queue)) grouped.set(queue, []);
    grouped.get(queue).push({ expectedDigest, resourceId: effect.resource_id });
  }

  const verified = { private_photo: 0, private_voice_intro: 0, identity_l3_media: 0 };
  for (const [queue, queueObligations] of grouped) {
    const rootKey = QUEUE_ROOTS[queue];
    const { entries } = await listRealDirectory(
      roots[rootKey],
      restoreRoot,
      'privacy_recovery_physical_' + rootKey
    );
    const names = new Set(entries.map(name => name.toLowerCase()));
    for (const obligation of queueObligations) {
      let remains = false;
      if (queue === 'private_photo') {
        remains = names.has(obligation.resourceId.toLowerCase() + '.jpg') ||
          names.has(obligation.resourceId.toLowerCase() + '.png');
      } else if (queue === 'private_voice_intro') {
        remains = names.has(obligation.resourceId.toLowerCase() + '.enc');
      } else {
        remains = entries.some(name => digest(name) === obligation.expectedDigest);
      }
      if (remains) throw new Error('privacy_recovery_physical_media_still_exists');
      verified[queue] += 1;
    }
  }

  return {
    verifiedPhotoObjectAbsenceCount: verified.private_photo,
    verifiedVoiceObjectAbsenceCount: verified.private_voice_intro,
    verifiedIdentityL3ObjectAbsenceCount: verified.identity_l3_media
  };
}
