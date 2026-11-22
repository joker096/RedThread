import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyPhysicalPurgeAbsence } from './privacyRecoveryPhysicalPurgeVerification.js';

const ids = {
  photo: '123e4567-e89b-42d3-a456-426614174001',
  voice: '123e4567-e89b-42d3-a456-426614174002',
  l3: '123e4567-e89b-42d3-a456-426614174003'
};
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vow-physical-purge-'));
  const roots = {
    private_photo: path.join(base, 'photos'),
    private_voice_intro: path.join(base, 'voice'),
    identity_l3_media: path.join(base, 'l3'),
    identity_l3_temp: path.join(base, 'l3-temp')
  };
  await Promise.all(Object.values(roots).map(root => mkdir(root, { mode: 0o700 })));
  return { base, roots };
}

test('physical attestation passes only when obligated photo, voice and L3 objects are absent', async () => {
  const { base, roots } = await fixture();
  try {
    const obligations = [
      { queue_name: 'private_photo', storage_path_sha256: sha(path.join(roots.private_photo, ids.photo + '.jpg')) },
      { queue_name: 'private_voice_intro', storage_path_sha256: sha(path.join(roots.private_voice_intro, ids.voice + '.enc')) },
      { queue_name: 'identity_l3_media', storage_path_sha256: sha(ids.l3) }
    ];
    const result = await verifyPhysicalPurgeAbsence({ obligations, storageRoots: roots });
    assert.deepEqual(result, { complete: true, verifiedObjectCount: 3 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('physical attestation rejects an object that remains in any of the three storage roots', async () => {
  for (const queueName of ['private_photo', 'private_voice_intro', 'identity_l3_media']) {
    const { base, roots } = await fixture();
    try {
      const filename = queueName === 'private_photo' ? ids.photo + '.jpg'
        : queueName === 'private_voice_intro' ? ids.voice + '.enc' : ids.l3;
      const locator = queueName === 'identity_l3_media'
        ? filename : path.join(roots[queueName], filename);
      await writeFile(path.join(roots[queueName], filename), 'synthetic encrypted fixture');
      await assert.rejects(
        verifyPhysicalPurgeAbsence({
          obligations: [{ queue_name: queueName, storage_path_sha256: sha(locator) }],
          storageRoots: roots
        }),
        new RegExp('privacy_recovery_physical_object_still_exists:' + queueName)
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
});

test('physical attestation fails closed for missing or symlinked storage roots', async () => {
  const { base, roots } = await fixture();
  const obligation = {
    queue_name: 'private_photo',
    storage_path_sha256: sha(path.join(roots.private_photo, ids.photo + '.jpg'))
  };
  try {
    await assert.rejects(
      verifyPhysicalPurgeAbsence({
        obligations: [obligation],
        storageRoots: { ...roots, private_photo: path.join(base, 'missing') }
      }),
      /privacy_recovery_physical_storage_root_unavailable:private_photo/
    );
    const linked = path.join(base, 'linked');
    await symlink(roots.private_photo, linked, 'dir');
    await assert.rejects(
      verifyPhysicalPurgeAbsence({
        obligations: [obligation],
        storageRoots: { ...roots, private_photo: linked }
      }),
      /privacy_recovery_physical_storage_root_unsafe:private_photo/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('physical attestation rejects a symlinked parent path component', async () => {
  const { base, roots } = await fixture();
  try {
    const realParent = path.join(base, 'real-parent');
    const linkedParent = path.join(base, 'linked-parent');
    await mkdir(path.join(realParent, 'photos'), { recursive: true, mode: 0o700 });
    await symlink(realParent, linkedParent, 'dir');
    const linkedRoot = path.join(linkedParent, 'photos');
    await assert.rejects(
      verifyPhysicalPurgeAbsence({
        obligations: [{
          queue_name: 'private_photo',
          storage_path_sha256: sha(path.join(linkedRoot, ids.photo + '.jpg'))
        }],
        storageRoots: { ...roots, private_photo: linkedRoot }
      }),
      /privacy_recovery_physical_storage_root_unsafe:private_photo/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('physical attestation rejects malformed or unsupported obligations', async () => {
  await assert.rejects(
    verifyPhysicalPurgeAbsence({ obligations: [null] }),
    /privacy_recovery_physical_obligation_invalid/
  );
  await assert.rejects(
    verifyPhysicalPurgeAbsence({ obligations: [{ queue_name: 'unknown', storage_path_sha256: 'a'.repeat(64) }] }),
    /privacy_recovery_physical_obligation_invalid/
  );
  await assert.rejects(
    verifyPhysicalPurgeAbsence({ obligations: [{ queue_name: 'private_photo', storage_path_sha256: 'not-a-digest' }] }),
    /privacy_recovery_physical_obligation_invalid/
  );
});


test('physical attestation rejects abandoned encrypted L3 staging objects', async () => {
  const { base, roots } = await fixture();
  try {
    await writeFile(path.join(roots.identity_l3_media, '.tmp-' + ids.l3), 'partial encrypted upload');
    await assert.rejects(
      verifyPhysicalPurgeAbsence({
        obligations: [],
        storageRoots: roots
      }),
      /privacy_recovery_physical_temporary_object_remains:identity_l3_media/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});


test('physical attestation rejects any leftover plaintext L3 scratch entry', async () => {
  const { base, roots } = await fixture();
  try {
    await writeFile(path.join(roots.identity_l3_temp, '.decrypt-' + ids.l3), 'synthetic plaintext staging fixture');
    await assert.rejects(
      verifyPhysicalPurgeAbsence({ obligations: [], storageRoots: roots }),
      /privacy_recovery_physical_temporary_object_remains:identity_l3_temp/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('physical attestation requires the separate L3 scratch root', async () => {
  const { base, roots } = await fixture();
  try {
    const { identity_l3_temp, ...withoutScratch } = roots;
    await assert.rejects(
      verifyPhysicalPurgeAbsence({ obligations: [], storageRoots: withoutScratch }),
      /privacy_recovery_physical_storage_root_missing:identity_l3_temp/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
