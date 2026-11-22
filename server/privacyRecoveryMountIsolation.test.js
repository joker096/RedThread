import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrivateMediaRootsReadOnly, parseMountInfo } from './privacyRecoveryMountIsolation.js';

const roots = {
  private_photo: '/restore/media/photos',
  private_voice_intro: '/restore/media/voice',
  identity_l3_media: '/restore/media/l3',
  identity_l3_temp: '/restore/scratch/l3'
};

const readonlyMounts = [
  '31 25 0:28 / / rw,relatime - ext4 /dev/root rw',
  '42 31 0:45 / /restore rw,relatime - ext4 /dev/restore rw',
  '43 42 0:46 / /restore/media rw,relatime,ro - ext4 /dev/restore-media rw',
  '46 42 0:49 / /restore/scratch rw,relatime,ro - tmpfs tmpfs rw'
].join('\n');

test('mountinfo parser decodes escaped mount paths and preserves per-mount read-only options', () => {
  const parsed = parseMountInfo(String.raw`44 42 0:47 / /restore/media/private\040data ro,nosuid,nodev - ext4 /dev/secure rw`);
  assert.equal(parsed[0].mountPoint, '/restore/media/private data');
  assert.equal(parsed[0].mountOptions.has('ro'), true);
});

test('all private media roots must be covered by a read-only mount', () => {
  const result = assertPrivateMediaRootsReadOnly({ mountInfo: readonlyMounts, storageRoots: roots });
  assert.equal(result.verifiedReadOnlyMountCount, 4);
});

test('a writable mount fails closed even when its parent mount is read-only', () => {
  const mountInfo = readonlyMounts + '\n45 43 0:48 / /restore/media/photos rw,relatime - ext4 /dev/photos rw';
  assert.throws(
    () => assertPrivateMediaRootsReadOnly({ mountInfo, storageRoots: roots }),
    /privacy_recovery_storage_mount_not_read_only:private_photo/
  );
});

test('missing mount coverage fails closed', () => {
  assert.throws(
    () => assertPrivateMediaRootsReadOnly({ mountInfo: '31 25 0:28 / / rw,relatime - ext4 /dev/root rw', storageRoots: roots }),
    /privacy_recovery_storage_mount_not_read_only:private_photo/
  );
});

test('relative roots and malformed mountinfo are rejected', () => {
  assert.throws(
    () => assertPrivateMediaRootsReadOnly({ mountInfo: readonlyMounts, storageRoots: { private_photo: 'uploads/photos' } }),
    /privacy_recovery_readonly_storage_root_invalid:private_photo/
  );
  assert.throws(() => parseMountInfo('not-mountinfo'), /privacy_recovery_mountinfo_malformed/);
});
