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
  roots = {};
  for (const key of ['photo', 'voice', 'identityL3']) {
    roots[key] = path.join(root, key);
    await mkdir(roots[key], { mode: 0o700 });
  }
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

test('physical verifier accepts absent photo, voice and L3 objects', async () => {
  const photo = path.join(roots.photo, randomUUID() + '.jpg');
  const voice = path.join(roots.voice, randomUUID() + '.enc');
  const l3 = randomUUID();
  const result = await verifyPhysicalMediaAbsence({
    roots,
    obligations: [
      { queue_name: 'private_photo', storage_path_sha256: sha256(photo) },
      { queue_name: 'private_voice_intro', storage_path_sha256: sha256(voice) },
      { queue_name: 'identity_l3_media', storage_path_sha256: sha256(l3) }
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
    ['private_photo', 'photo', randomUUID() + '.jpg', value => path.join(roots.photo, value)],
    ['private_voice_intro', 'voice', randomUUID() + '.enc', value => path.join(roots.voice, value)],
    ['identity_l3_media', 'identityL3', randomUUID(), value => value]
  ];
  for (const [queue_name, rootKey, name, hashValue] of cases) {
    await t.test(queue_name, async () => {
      const location = path.join(roots[rootKey], name);
      await writeFile(location, 'synthetic encrypted fixture', { mode: 0o600 });
      const value = hashValue(name);
      await assert.rejects(
        verifyPhysicalMediaAbsence({
          roots,
          obligations: [{ queue_name, storage_path_sha256: sha256(value) }]
        }),
        /privacy_recovery_physical_media_still_exists/
      );
      await rm(location, { force: true });
    });
  }
});

test('physical verifier fails closed when a required storage root is missing or unsafe', async () => {
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots: { ...roots, voice: path.join(root, 'missing') },
      obligations: [{ queue_name: 'private_voice_intro', storage_path_sha256: 'a'.repeat(64) }]
    }),
    /privacy_recovery_physical_voice_storage_unavailable/
  );
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots: { ...roots, photo: '' },
      obligations: [{ queue_name: 'private_photo', storage_path_sha256: 'b'.repeat(64) }]
    }),
    /privacy_recovery_physical_photo_root_required/
  );
});

test('physical verifier rejects malformed obligation metadata', async () => {
  await assert.rejects(
    verifyPhysicalMediaAbsence({
      roots,
      obligations: [{ queue_name: 'private_photo', storage_path_sha256: 'not-a-digest' }]
    }),
    /privacy_recovery_physical_obligation_invalid/
  );
});
