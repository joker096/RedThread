import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  assertIdentityL3StorageReady,
  assertIdentityL3TemporaryStorageReady,
  clearIdentityL3TemporaryFiles,
  deleteIdentityL3Object,
  IdentityL3StorageError,
  openIdentityL3Stream,
  parseIdentityL3EncryptionKey,
  storeIdentityL3Stream
} from './identityL3Storage.js';

const key = '8f'.repeat(32);
const otherKey = 'a1'.repeat(32);
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function withStorage(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-l3-storage-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('L3 storage readiness validates key and both private mount permissions', async () => {
  await withStorage(async root => {
    const encryptedRoot = path.join(root, 'encrypted');
    const scratchRoot = path.join(root, 'scratch');
    await mkdir(encryptedRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    assert.equal(await assertIdentityL3StorageReady({
      root: encryptedRoot, tempRoot: scratchRoot, key
    }), true);
    await assert.rejects(
      assertIdentityL3StorageReady({ root: encryptedRoot, tempRoot: scratchRoot, key: 'invalid' }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_key_invalid'
    );
    await chmod(scratchRoot, 0o755);
    await assert.rejects(
      assertIdentityL3StorageReady({ root: encryptedRoot, tempRoot: scratchRoot, key }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_root_unsafe'
    );
  });
});

test('L3-disabled startup cleanup guard rejects scratch aliases before deleting encrypted media', async () => {
  await withStorage(async root => {
    const encryptedRoot = path.join(root, 'encrypted');
    const scratchRoot = path.join(root, 'scratch');
    await mkdir(encryptedRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    const encryptedObject = path.join(encryptedRoot, 'retained-encrypted-object');
    await writeFile(encryptedObject, 'encrypted-evidence');
    assert.equal(await assertIdentityL3TemporaryStorageReady({
      root: encryptedRoot, tempRoot: scratchRoot
    }), true, 'separate private roots remain safe to clean while L3 is disabled');

    for (const tempRoot of [encryptedRoot, path.join(encryptedRoot, 'nested'), root]) {
      await assert.rejects(
        assertIdentityL3TemporaryStorageReady({ root: encryptedRoot, tempRoot }),
        error => error instanceof IdentityL3StorageError &&
          error.code === 'l3_storage_roots_must_be_disjoint'
      );
    }

    const symlinkAlias = path.join(root, 'scratch-alias');
    await symlink(encryptedRoot, symlinkAlias);
    await assert.rejects(
      assertIdentityL3TemporaryStorageReady({ root: encryptedRoot, tempRoot: symlinkAlias }),
      error => error instanceof IdentityL3StorageError &&
        error.code === 'l3_storage_root_unsafe'
    );

    assert.equal(await readFile(encryptedObject, 'utf8'), 'encrypted-evidence',
      'an invalid disabled-feature scratch path must not permit encrypted media deletion');
  });
});

test('L3 storage readiness rejects overlapping encrypted and scratch roots', async () => {
  await withStorage(async root => {
    const encryptedRoot = path.join(root, 'encrypted');
    const scratchRoot = path.join(root, 'scratch');
    await mkdir(encryptedRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    for (const tempRoot of [
      encryptedRoot,
      path.join(encryptedRoot, 'nested-scratch'),
      path.dirname(encryptedRoot)
    ]) {
      await assert.rejects(
        assertIdentityL3StorageReady({ root: encryptedRoot, tempRoot, key }),
        error => error instanceof IdentityL3StorageError &&
          error.code === 'l3_storage_roots_must_be_disjoint'
      );
    }
    assert.deepEqual(await readdir(encryptedRoot), [],
      'readiness must reject overlapping roots before cleanup can touch encrypted media');
  });
});

if (process.platform === 'linux') {
  test('L3 production readiness rejects ordinary directories when mountpoints are required', async () => {
    await withStorage(async root => {
      const encryptedRoot = path.join(root, 'encrypted');
      const scratchRoot = path.join(root, 'scratch');
      await mkdir(encryptedRoot, { mode: 0o700 });
      await mkdir(scratchRoot, { mode: 0o700 });
      await assert.rejects(
        assertIdentityL3StorageReady({
          root: encryptedRoot, tempRoot: scratchRoot, key, requireMount: true
        }),
        error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_mount_missing'
      );
    });
  });
}

test('L3 storage rejects replaceable writable parents but permits sticky shared parents', async () => {
  await withStorage(async root => {
    const unsafeParent = path.join(root, 'unsafe-parent');
    const scratchRoot = path.join(root, 'scratch');
    await mkdir(unsafeParent, { mode: 0o700 });
    await chmod(unsafeParent, 0o770);
    await mkdir(path.join(unsafeParent, 'encrypted'), { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    await assert.rejects(
      assertIdentityL3StorageReady({
        root: path.join(unsafeParent, 'encrypted'), tempRoot: scratchRoot, key
      }),
      error => error instanceof IdentityL3StorageError &&
        error.code === 'l3_storage_root_unsafe'
    );

    const stickyParent = path.join(root, 'sticky-parent');
    await mkdir(stickyParent, { mode: 0o700 });
    await chmod(stickyParent, 0o1770);
    const stickyEncryptedRoot = path.join(stickyParent, 'encrypted');
    const stickyScratchRoot = path.join(root, 'sticky-scratch');
    await mkdir(stickyEncryptedRoot, { mode: 0o700 });
    await mkdir(stickyScratchRoot, { mode: 0o700 });
    assert.equal(await assertIdentityL3StorageReady({
      root: stickyEncryptedRoot, tempRoot: stickyScratchRoot, key
    }), true, 'sticky shared parents protect child ownership from rename attacks');
  });
});

test('L3 storage rejects owner-writable ancestors owned by another principal', async t => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    t.skip('requires root to create a foreign-owned writable ancestor');
    return;
  }
  await withStorage(async root => {
    const foreignParent = path.join(root, 'foreign-owner-parent');
    const encryptedRoot = path.join(foreignParent, 'encrypted');
    const scratchRoot = path.join(root, 'foreign-owner-scratch');
    await mkdir(foreignParent, { mode: 0o700 });
    await chown(foreignParent, 65534, 65534);
    await chmod(foreignParent, 0o755);
    await mkdir(encryptedRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });

    await assert.rejects(
      assertIdentityL3StorageReady({ root: encryptedRoot, tempRoot: scratchRoot, key }),
      error => error instanceof IdentityL3StorageError &&
        error.code === 'l3_storage_root_unsafe'
    );
  });
});

test('L3 storage rejects a symlink in any parent component of the private root', async () => {
  await withStorage(async root => {
    const actualParent = path.join(root, 'actual-parent');
    const symlinkParent = path.join(root, 'symlink-parent');
    await mkdir(actualParent, { mode: 0o700 });
    await symlink(actualParent, symlinkParent, 'dir');

    await assert.rejects(
      storeIdentityL3Stream({
        source: Readable.from([Buffer.from('private media')]),
        root: path.join(symlinkParent, 'private-l3'),
        key
      }),
      error => error instanceof IdentityL3StorageError &&
        error.code === 'l3_storage_root_unsafe'
    );
    assert.deepEqual(await readdir(actualParent), [],
      'a rejected symlink path must not create directories at its target');
  });
});

test('L3 storage fails closed when the private root is accessible to group or other users', async () => {
  await withStorage(async root => {
    await chmod(root, 0o755);
    await assert.rejects(
      storeIdentityL3Stream({ source: Readable.from([Buffer.from('private media')]), root, key }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_root_unsafe'
    );
    await chmod(root, 0o700);
    const stored = await storeIdentityL3Stream({
      source: Readable.from([Buffer.from('private media')]), root, key
    });
    assert.equal(stored.sizeBytes, Buffer.byteLength('private media'));
  });
});

test('L3 storage encrypts streams and decrypts only authenticated content', async () => {
  await withStorage(async root => {
    const original = Buffer.from('private L3 video bytes'.repeat(4096));
    const stored = await storeIdentityL3Stream({ source: Readable.from([original]), root, key });
    assert.equal(stored.sizeBytes, original.length);
    assert.equal(stored.sha256.length, 64);
    const encrypted = await readFile(path.join(root, stored.objectKey));
    assert.deepEqual(encrypted.subarray(0, 8), Buffer.from([0x56, 0x4f, 0x57, 0x4c, 0x33, 0x56, 0x32, 0x00]));
    assert.equal(encrypted.includes(original), false);
    assert.deepEqual(await collect(await openIdentityL3Stream({ objectKey: stored.objectKey, root, key })), original);
    assert.deepEqual((await readdir(root)).sort(), [stored.objectKey]);
  });
});

test('L3 decryption stages plaintext only in a separate private scratch directory', async () => {
  await withStorage(async root => {
    const encryptedRoot = path.join(root, 'encrypted');
    const scratchRoot = path.join(root, 'scratch');
    await mkdir(encryptedRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    const original = Buffer.from('private moderator review video'.repeat(2048));
    const stored = await storeIdentityL3Stream({
      source: Readable.from([original]), root: encryptedRoot, key
    });
    const stream = await openIdentityL3Stream({
      objectKey: stored.objectKey,
      root: encryptedRoot,
      tempRoot: scratchRoot,
      key
    });
    assert.deepEqual(await collect(stream), original);
    assert.deepEqual(await readdir(encryptedRoot), [stored.objectKey],
      'the read-only encrypted-media directory must never receive plaintext staging files');
    assert.deepEqual(await readdir(scratchRoot), [],
      'the private scratch file must be removed when the stream closes');

    const abandoned = path.join(scratchRoot, '.decrypt-cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await writeFile(abandoned, 'stale plaintext', { mode: 0o600 });
    const abandonedProcessingDirectory = await mkdtemp(path.join(scratchRoot, 'vow-l3-check-'));
    await writeFile(path.join(abandonedProcessingDirectory, 'media.bin'), 'stale processed plaintext', { mode: 0o600 });
    const cleanup = await clearIdentityL3TemporaryFiles({ root: scratchRoot });
    assert.equal(cleanup.deletedCount, 2);
    assert.deepEqual(await readdir(scratchRoot), [],
      'startup must empty the dedicated scratch mount after an interrupted process');
  });
});

test('L3 storage rejects a wrong key and ciphertext tampering', async () => {
  await withStorage(async root => {
    const stored = await storeIdentityL3Stream({
      source: Readable.from([Buffer.from('sensitive video payload')]), root, key
    });
    await assert.rejects(
      () => openIdentityL3Stream({ objectKey: stored.objectKey, root, key: otherKey }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_authentication_failed'
    );
    assert.deepEqual((await readdir(root)).sort(), [stored.objectKey],
      'failed authentication must remove any staged plaintext');
    const filePath = path.join(root, stored.objectKey);
    const encrypted = await readFile(filePath);
    encrypted[encrypted.length - 17] ^= 0x01;
    await writeFile(filePath, encrypted);
    await assert.rejects(
      () => openIdentityL3Stream({ objectKey: stored.objectKey, root, key }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_authentication_failed'
    );
    assert.deepEqual((await readdir(root)).sort(), [stored.objectKey],
      'tampered ciphertext must never leave a staged plaintext file');
  });
});

test('L3 storage binds authenticated ciphertext to its opaque object key', async () => {
  await withStorage(async root => {
    const first = await storeIdentityL3Stream({
      source: Readable.from([Buffer.from('first account private media')]), root, key
    });
    const second = await storeIdentityL3Stream({
      source: Readable.from([Buffer.from('second account private media')]), root, key
    });
    const firstCiphertext = await readFile(path.join(root, first.objectKey));
    await writeFile(path.join(root, second.objectKey), firstCiphertext);
    await assert.rejects(
      () => openIdentityL3Stream({ objectKey: second.objectKey, root, key }),
      error => error instanceof IdentityL3StorageError &&
        error.code === 'l3_storage_authentication_failed'
    );
  });
});

test('L3 storage enforces upload size and removes partial temporary objects', async () => {
  await withStorage(async root => {
    await assert.rejects(
      storeIdentityL3Stream({
        source: Readable.from([Buffer.alloc(33), Buffer.alloc(33)]),
        root,
        key,
        maxBytes: 64
      }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_media_too_large'
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test('L3 storage validates keys and never accepts caller-controlled object paths', async () => {
  assert.throws(() => parseIdentityL3EncryptionKey('not-a-key'),
    error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_key_invalid');
  await withStorage(async root => {
    await assert.rejects(
      openIdentityL3Stream({ objectKey: '../private-photos/secret', root, key }),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_object_key_invalid'
    );
    assert.equal(await deleteIdentityL3Object({ objectKey: '00000000-0000-4000-8000-000000000000', root }), false);
  });
});


test('L3 storage refuses a symlink substituted for a stored object', async () => {
  await withStorage(async root => {
    const stored = await storeIdentityL3Stream({
      source: Readable.from([Buffer.from('private media')]), root, key
    });
    const objectPath = path.join(root, stored.objectKey);
    const movedPath = path.join(root, 'original-object');
    await rename(objectPath, movedPath);
    await symlink(movedPath, objectPath);
    await assert.rejects(
      openIdentityL3Stream({ objectKey: stored.objectKey, root, key }),
      error => error instanceof IdentityL3StorageError &&
        error.code === 'l3_storage_object_invalid'
    );
  });
});
