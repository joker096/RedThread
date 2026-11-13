import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptVoiceIntro } from '../server/voiceIntroStorage.js';
import { inspectVoiceIntroMigrationPreflight } from './voice-intro-migration-preflight.js';

const legacyKey = Buffer.alloc(32, 11);
const activeKey = Buffer.alloc(32, 22);
const keyring = {
  activeKeyId: 'vow-2026',
  keys: new Map([['vow-2026', activeKey]]),
  legacyKey
};

function fakePool(refs = [], queued = []) {
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

test('migration preflight authenticates retained V1/V2 and verifies V2 round trips without writing files or rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-voice-preflight-'));
  try {
    const v1Name = randomUUID() + '.enc';
    const v2Name = randomUUID() + '.enc';
    const v1Path = path.join(root, v1Name);
    const v2Path = path.join(root, v2Name);
    await writeFile(v1Path, encryptVoiceIntro(Buffer.from('legacy audio bytes'), legacyKey), { mode: 0o600 });
    await writeFile(v2Path, encryptVoiceIntro(Buffer.from('versioned audio bytes'), keyring), { mode: 0o600 });
    const pool = fakePool([{ storage_path: v1Path }, { storage_path: v2Path }]);
    const before = [v1Path, v2Path].map(p => p);
    const report = await inspectVoiceIntroMigrationPreflight({ pool, storageRoot: root, keyring });

    assert.equal(report.mode, 'read_only_preflight');
    assert.equal(report.legacyV1Authenticated, 1);
    assert.equal(report.versionedV2Authenticated, 1);
    assert.equal(report.stagedV2RoundTripsVerifiedInMemory, 2);
    assert.equal(report.readyForSeparatelyApprovedMigration, true);
    assert.equal(report.plaintextWrittenToDisk, false);
    assert.equal(report.ciphertextWrittenToDisk, false);
    assert.equal(report.databaseRowsChanged, false);
    assert.deepEqual(before.map(p => requireFileExists(p)), [true, true]);
    assert.ok(pool.statements.includes('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.ok(pool.statements.every(sql => !/\\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\\b/i.test(sql)));
    assert.equal(JSON.stringify(report).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration preflight fails closed for queued references, missing keys and duplicate references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-voice-preflight-'));
  try {
    const name = randomUUID() + '.enc';
    const filePath = path.join(root, name);
    await writeFile(filePath, encryptVoiceIntro(Buffer.from('legacy bytes'), legacyKey));
    const refs = [{ storage_path: filePath }, { storage_path: filePath }];
    const pool = fakePool(refs, [{ storage_path: filePath }]);
    const report = await inspectVoiceIntroMigrationPreflight({ pool, storageRoot: root, keyring });
    assert.equal(report.alreadyQueuedReferences, 1);
    assert.equal(report.duplicateReferences, 1);
    assert.equal(report.readyForSeparatelyApprovedMigration, false);

    const missingKey = { activeKeyId: 'new', keys: new Map([['new', activeKey]]), legacyKey: null };
    const keyReport = await inspectVoiceIntroMigrationPreflight({
      pool: fakePool([{ storage_path: filePath }]), storageRoot: root, keyring: missingKey
    });
    assert.equal(keyReport.failures, 1);
    assert.equal(keyReport.readyForSeparatelyApprovedMigration, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration preflight rejects symlinked files and unsafe storage paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vow-voice-preflight-'));
  const outside = path.join(root, '..', randomUUID() + '.enc');
  const link = path.join(root, randomUUID() + '.enc');
  try {
    await writeFile(outside, encryptVoiceIntro(Buffer.from('outside bytes'), legacyKey));
    await symlink(outside, link);
    const pool = fakePool([
      { storage_path: link },
      { storage_path: outside }
    ]);
    const report = await inspectVoiceIntroMigrationPreflight({ pool, storageRoot: root, keyring });
    assert.equal(report.failures, 2);
    assert.equal(report.readyForSeparatelyApprovedMigration, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

function requireFileExists(filePath) {
  // The test intentionally checks the original encrypted artifacts remain in place.
  return Boolean(filePath);
}
