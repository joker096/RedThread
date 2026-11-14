import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  encryptVoiceIntro
} from './voiceIntroStorage.js';
import {
  authenticateVoiceIntroMigrationSource,
  stageVoiceIntroMigrationCiphertext,
  verifyVoiceIntroMigrationStage
} from './voiceIntroMigrationFiles.js';

const digest = value => createHash('sha256').update(value).digest('hex');

test('voice migration file staging is authenticated, encrypted, private and retry-safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-migration-'));
  await chmod(root, 0o700);
  const legacyKey = Buffer.alloc(32, 7);
  const targetKey = Buffer.alloc(32, 9);
  const keyring = {
    activeKeyId: 'voice-new',
    keys: new Map([['voice-old', legacyKey], ['voice-new', targetKey]]),
    legacyKey
  };
  const plaintext = Buffer.from('private voice introduction fixture bytes');
  const sourceCiphertext = encryptVoiceIntro(plaintext, legacyKey);
  const sourcePath = path.join(root, randomUUID() + '.enc');
  const journalId = randomUUID();
  await writeFile(sourcePath, sourceCiphertext, { mode: 0o600 });

  try {
    const authenticated = await authenticateVoiceIntroMigrationSource({
      storageRoot: root,
      sourcePath,
      sourceSha256: digest(sourceCiphertext),
      sourceFormat: 'VOWVOICE1',
      keyring
    });
    assert.deepEqual(authenticated.plaintext, plaintext);

    const staged = await stageVoiceIntroMigrationCiphertext({
      storageRoot: root,
      journalId,
      sourcePath,
      plaintext: authenticated.plaintext,
      targetKeyId: 'voice-new',
      keyring
    });
    const info = await (await import('node:fs/promises')).stat(staged.stagedPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.notEqual(staged.stagedPath, sourcePath);

    const verified = await verifyVoiceIntroMigrationStage({
      storageRoot: root,
      ...staged,
      plaintext,
      keyring,
      targetKeyId: 'voice-new'
    });
    assert.deepEqual(verified, staged);

    const retry = await stageVoiceIntroMigrationCiphertext({
      storageRoot: root,
      journalId,
      sourcePath,
      plaintext,
      targetKeyId: 'voice-new',
      keyring
    });
    assert.deepEqual(retry, staged, 'retry reuses the authenticated deterministic stage');

    const changed = Buffer.from(plaintext);
    changed[0] ^= 1;
    await assert.rejects(stageVoiceIntroMigrationCiphertext({
      storageRoot: root,
      journalId,
      sourcePath,
      plaintext: changed,
      targetKeyId: 'voice-new',
      keyring
    }), /existing_stage_content_mismatch/);
    changed.fill(0);

    const tampered = await readFile(staged.stagedPath);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(staged.stagedPath, tampered, { mode: 0o600 });
    await assert.rejects(verifyVoiceIntroMigrationStage({
      storageRoot: root,
      ...staged,
      plaintext,
      keyring,
      targetKeyId: 'voice-new'
    }), /checksum_mismatch/);

    authenticated.plaintext.fill(0);
  } finally {
    plaintext.fill(0);
    sourceCiphertext.fill(0);
    legacyKey.fill(0);
    targetKey.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('voice migration file helpers reject symlinked storage roots', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-root-'));
  const real = path.join(parent, 'real');
  const linked = path.join(parent, 'linked');
  await mkdir(real, { mode: 0o700 });
  await symlink(real, linked);
  try {
    await assert.rejects(authenticateVoiceIntroMigrationSource({
      storageRoot: linked,
      sourcePath: path.join(real, randomUUID() + '.enc'),
      sourceSha256: 'a'.repeat(64),
      sourceFormat: 'VOWVOICE1',
      keyring: Buffer.alloc(32)
    }), /not_private_directory/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
