import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectVoiceIntroInventory } from './voice-intro-inventory.js';

function fakePool({ refs = [], queued = [] } = {}) {
  const statements = [];
  return {
    statements,
    connect: async () => ({
      query: async sql => {
        statements.push(sql);
        if (sql.startsWith('SELECT storage_path FROM profile_voice_intros')) return { rows: refs };
        if (sql.startsWith('SELECT storage_path FROM private_voice_intro_purge_queue')) return { rows: queued };
        return { rows: [] };
      },
      release() {}
    })
  };
}

function legacyEnvelope() {
  return Buffer.concat([Buffer.from('VOWVOICE1'), Buffer.alloc(12), Buffer.alloc(16), Buffer.from([1])]);
}
function versionedEnvelope(keyId = 'key_2026_02') {
  const id = Buffer.from(keyId);
  return Buffer.concat([Buffer.from('VOWVOICE2'), Buffer.from([id.length]), id, Buffer.alloc(12), Buffer.alloc(16), Buffer.from([1])]);
}

test('voice inventory is read-only and counts V1, V2, queued and orphaned files without exposing paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-voice-inventory-'));
  try {
    const legacyName = randomUUID() + '.enc';
    const v2Name = randomUUID() + '.enc';
    const orphanName = randomUUID() + '.enc';
    await writeFile(path.join(root, legacyName), legacyEnvelope(), { mode: 0o600 });
    await writeFile(path.join(root, v2Name), versionedEnvelope(), { mode: 0o600 });
    await writeFile(path.join(root, orphanName), legacyEnvelope(), { mode: 0o600 });
    const pool = fakePool({
      refs: [{ storage_path: path.join(root, legacyName) }, { storage_path: path.join(root, v2Name) }],
      queued: [{ storage_path: path.join(root, v2Name) }]
    });
    const result = await inspectVoiceIntroInventory({ pool, storageRoot: root });
    assert.equal(result.mode, 'read_only');
    assert.equal(result.decryptionPerformed, false);
    assert.equal(result.counts.databaseReferences, 2);
    assert.equal(result.counts.queuedForPurge, 1);
    assert.equal(result.counts.filesOnDisk, 3);
    assert.equal(result.counts.legacyV1, 2);
    assert.equal(result.counts.versionedV2, 1);
    assert.equal(result.counts.versionedByKeyId.key_2026_02, 1);
    assert.equal(result.counts.filesAlsoQueuedForPurge, 1);
    assert.equal(result.counts.orphanFiles, 1);
    assert.ok(pool.statements.includes('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.ok(pool.statements.every(sql => !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql)));
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(JSON.stringify(result).includes(legacyName), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('voice inventory reports missing references and malformed ciphertext', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-voice-inventory-'));
  try {
    const badName = randomUUID() + '.enc';
    await writeFile(path.join(root, badName), Buffer.from('plaintext-not-audio'));
    const pool = fakePool({
      refs: [{ storage_path: path.join(root, randomUUID() + '.enc') }, { storage_path: path.join(root, badName) }],
      queued: [{ storage_path: path.join(root, randomUUID() + '.enc') }]
    });
    const result = await inspectVoiceIntroInventory({ pool, storageRoot: root });
    assert.equal(result.counts.missingReferencedFiles, 1);
    assert.equal(result.counts.missingQueuedFiles, 1);
    assert.equal(result.counts.malformedCiphertext, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('voice inventory rejects symlink storage roots and does not follow symlinked files', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'vow-voice-inventory-'));
  const root = path.join(parent, 'root');
  const target = path.join(parent, 'target');
  try {
    await mkdir(root);
    await mkdir(target);
    const name = randomUUID() + '.enc';
    await writeFile(path.join(target, name), legacyEnvelope());
    await symlink(path.join(target, name), path.join(root, name));
    const pool = fakePool({ refs: [{ storage_path: path.join(root, name) }] });
    const result = await inspectVoiceIntroInventory({ pool, storageRoot: root });
    assert.equal(result.counts.symlinkOrUnsafePaths, 1);
    const rootLink = path.join(parent, 'root-link');
    await symlink(root, rootLink);
    await assert.rejects(() => inspectVoiceIntroInventory({ pool, storageRoot: rootLink }), /not_a_real_directory/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('voice inventory refuses unsafe database storage paths without touching outside files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-voice-inventory-'));
  try {
    const outside = path.join(root, '..', randomUUID() + '.enc');
    const pool = fakePool({ refs: [{ storage_path: outside }] });
    const result = await inspectVoiceIntroInventory({ pool, storageRoot: root });
    assert.equal(result.counts.symlinkOrUnsafePaths, 1);
    assert.equal(result.counts.filesOnDisk, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
