import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPrivateVoiceIntroPurge } from './process-private-voice-intro-purge.js';

test('voice intro purge refuses to run when the persistent storage mount is missing', async () => {
  await assert.rejects(
    () => runPrivateVoiceIntroPurge({ storageRoot: path.join(os.tmpdir(), 'vow-missing-voice-volume-' + process.pid), pool: {} }),
    /not a directory|ENOENT/
  );
});

test('voice intro purge refuses a symlink as the private storage root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-purge-'));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  try {
    await mkdir(target);
    await symlink(target, link, 'dir');
    await assert.rejects(
      () => runPrivateVoiceIntroPurge({ storageRoot: link, pool: {} }),
      /voice_intro_storage_root_not_private_directory/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('voice intro purge processes one bounded batch when the private volume exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-purge-'));
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 })
  };
  try {
    const summary = await runPrivateVoiceIntroPurge({ storageRoot: root, pool, batchSize: 7 });
    assert.deepEqual(summary, { scanned: 0, deleted: 0, retried: 0, failures: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('voice intro purge rejects a symlinked ancestor of the private storage root', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-parent-'));
  const target = path.join(parent, 'target');
  const linked = path.join(parent, 'linked');
  try {
    await mkdir(target);
    await symlink(target, linked, 'dir');
    await assert.rejects(
      () => runPrivateVoiceIntroPurge({ storageRoot: path.join(linked, 'nested'), pool: {} }),
      /not_private_directory/
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
