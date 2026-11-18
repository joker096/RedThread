import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyPhysicalMediaAbsence } from './privacyRecoveryPhysicalMediaVerification.js';

let root;
let roots;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vow-physical-check-'));
  roots = { restoreRoot: root };
  await writeFile(path.join(root, '.vow-restore-pending'), 'pending', { mode: 0o600 });
  for (const key of ['photo', 'voice', 'identityL3']) {
    roots[key] = path.join(root, key);
    await mkdir(roots[key], { mode: 0o700 });
  }
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

test('physical verifier accepts absent photo, voice and L3 objects under pending staging', async () => {
  const photoId = randomUUID();
  const voiceId = randomUUID();
  const l3 = randomUUID();
  const result = await verifyPhysicalMediaAbsence({
    roots,
    obligations: [
      { ledger_sequence: '1', queue_name: 'private_photo', storage_path_sha256: sha256('photo-path'), storage_object_id: photoId },
      { ledger_sequence: '2', queue_name: 'private_voice_intro', storage_path_sha256: sha256('voice-path'), storage_object_id: voiceId },
      { ledger_sequence: '3', queue_name: 'identity_l3_media', storage_path_sha256: sha256(l3), storage_object_id: l3 }
    ]
  });
  assert.deepEqual(result, {
    verifiedPhotoObjectAbsenceCount: 1,
    verifiedVoiceObjectAbsenceCount: 1,
    verifiedIdentityL3ObjectAbsenceCount: 1
  });
});

test('physical verifier rejects a retained object for each media class', async t => {
  const cases = [
    ['private_photo', 'photo', randomUUID() + '.jpg'],
    ['private_voice_intro', 'voice', randomUUID() + '.enc'],
    ['identity_l3_media', 'identityL3', randomUUID()]
  ];
  for (const [queue_name, rootKey, name] of cases) {
    await t.test(queue_name, async () => {
      const location = path.join(roots[rootKey], name);
      await writeFile(location, 'synthetic encrypted fixture', { mode: 0o600 });
      const objectId = name.slice(0, name.lastIndexOf('.'));
      const expectedDigest = queue_name === 'identity_l3_media' ? sha256(name) : sha256('opaque-path-digest');
      try {
        await assert.rejects(
          verifyPhysicalMediaAbsence({
            roots,
            obligations: [{ ledger_sequence: '1', queue_name, storage_path_sha256: expectedDigest, storage_object_id: objectId }]
          }),
          /privacy_recovery_physical_media_still_exists/
        );
      } finally {
        await rm(location, { force: true });
      }
    });
  }
});

test('physical verifier fails closed when the pending restore marker or a storage root is missing', async () => {
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots: { ...roots, restoreRoot: path.join(root, 'missing') },
      obligations: [{ ledger_sequence: '1', queue_name: 'private_photo', storage_path_sha256: 'a'.repeat(64), storage_object_id: randomUUID() }]
    }),
    /privacy_recovery_physical_restore_root_unavailable/
  );
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots: { ...roots, voice: path.join(root, 'missing') },
      obligations: [{ ledger_sequence: '1', queue_name: 'private_voice_intro', storage_path_sha256: 'b'.repeat(64), storage_object_id: randomUUID() }]
    }),
    /privacy_recovery_physical_voice_storage_unavailable/
  );
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots: { ...roots, photo: '' },

      obligations: [{ ledger_sequence: '1', queue_name: 'private_photo', storage_path_sha256: 'c'.repeat(64), storage_object_id: randomUUID() }]
    }),
    /privacy_recovery_physical_photo_root_required/
  );
});

test('physical verifier rejects storage roots outside the isolated restore tree', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vow-outside-'));
  try {
    await assert.rejects(
      verifyPhysicalMediaAbsence({
        roots: { ...roots, photo: outside },
        obligations: [{ ledger_sequence: '1', queue_name: 'private_photo', storage_path_sha256: 'd'.repeat(64), storage_object_id: randomUUID() }]
      }),
      /privacy_recovery_physical_photo_root_outside_restore/
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('physical verifier rejects malformed obligation metadata and missing object IDs', async () => {
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots,
      obligations: [{ ledger_sequence: '1', queue_name: 'private_photo', storage_path_sha256: 'not-a-digest', storage_object_id: randomUUID() }]
    }),
    /privacy_recovery_physical_obligation_invalid/
  );
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots,
      obligations: [{ ledger_sequence: '1', queue_name: 'private_photo', storage_path_sha256: 'e'.repeat(64) }]
    }),
    /privacy_recovery_physical_object_id_missing/
  );
});
