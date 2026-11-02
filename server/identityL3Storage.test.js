import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
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

test('L3 storage encrypts streams and decrypts only authenticated content', async () => {
  await withStorage(async root => {
    const original = Buffer.from('private L3 video bytes'.repeat(4096));
    const stored = await storeIdentityL3Stream({ source: Readable.from([original]), root, key });
    assert.equal(stored.sizeBytes, original.length);
    assert.equal(stored.sha256.length, 64);
    const encrypted = await readFile(path.join(root, stored.objectKey));
    assert.deepEqual(encrypted.subarray(0, 8), Buffer.from([0x56, 0x4f, 0x57, 0x4c, 0x33, 0x56, 0x31, 0x00]));
    assert.equal(encrypted.includes(original), false);
    assert.deepEqual(await collect(await openIdentityL3Stream({ objectKey: stored.objectKey, root, key })), original);
    assert.deepEqual((await readdir(root)).sort(), [stored.objectKey]);
  });
});

test('L3 storage rejects a wrong key and ciphertext tampering', async () => {
  await withStorage(async root => {
    const stored = await storeIdentityL3Stream({
      source: Readable.from([Buffer.from('sensitive video payload')]), root, key
    });
    await assert.rejects(
      collect(await openIdentityL3Stream({ objectKey: stored.objectKey, root, key: otherKey })),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_authentication_failed'
    );
    const filePath = path.join(root, stored.objectKey);
    const encrypted = await readFile(filePath);
    encrypted[encrypted.length - 17] ^= 0x01;
    await writeFile(filePath, encrypted);
    await assert.rejects(
      collect(await openIdentityL3Stream({ objectKey: stored.objectKey, root, key })),
      error => error instanceof IdentityL3StorageError && error.code === 'l3_storage_authentication_failed'
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
