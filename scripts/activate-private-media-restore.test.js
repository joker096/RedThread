import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./activate-private-media-restore.sh', import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-private-media-activation-'));
  const bin = path.join(root, 'bin');
  const restore = path.join(root, 'restored');
  const mountpoint = path.join(root, 'mountpoint');
  const gate = path.join(root, 'privacy-gate');
  const writerGate = path.join(root, 'writer-isolation-gate');
  const log = path.join(root, 'calls.log');
  await Promise.all([mkdir(bin), mkdir(restore), mkdir(mountpoint)]);
  await writeFile(path.join(restore, 'photo.fixture'), 'private');
  await writeFile(path.join(restore, '.vow-restore-pending'), '');
  await writeFile(log, '');
  await writeFile(gate, '#!/usr/bin/env bash\nset -eu\nprintf "gate:%s\\n" "$RESTORE_DESTINATION" >> "$CALL_LOG"\nexit "${GATE_EXIT:-0}"\n');
  await chmod(gate, 0o700);
  await writeFile(writerGate, '#!/usr/bin/env bash\nset -eu\nprintf "writer:%s\\n" "$RESTORE_DESTINATION" >> "$CALL_LOG"\nexit "${WRITER_GATE_EXIT:-0}"\n');
  await chmod(writerGate, 0o700);
  await writeFile(path.join(bin, 'mountpoint'), '#!/usr/bin/env bash\nexit 1\n');
  await chmod(path.join(bin, 'mountpoint'), 0o700);
  await writeFile(path.join(bin, 'mount'), '#!/usr/bin/env bash\nset -eu\nprintf "mount:%s\\n" "$*" >> "$CALL_LOG"\nexit "${MOUNT_EXIT:-0}"\n');
  await chmod(path.join(bin, 'mount'), 0o700);
  return { root, bin, restore, mountpoint, gate, writerGate, log };
}

function run(f, overrides = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH || ''}`,
      RESTORE_DESTINATION: f.restore,
      PRIVATE_MEDIA_MOUNTPOINT: f.mountpoint,
      PRIVACY_RECOVERY_GATE_EXECUTABLE: f.gate,
      PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE: f.writerGate,
      CALL_LOG: f.log,
      ...overrides
    }
  });
}

test('restored media cannot be mounted when privacy reconciliation gate fails', async () => {
  const f = await fixture();
  try {
    const result = run(f, { GATE_EXIT: '42' });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(f.restore, '.vow-restore-pending'), 'utf8'), '');
    await assert.rejects(lstat(path.join(f.restore, '.vow-privacy-reconciled')), { code: 'ENOENT' });
    assert.equal(await readFile(f.log, 'utf8').then(value => value.includes('mount:')), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('restored media is mounted only after the gate succeeds and receives a reconciliation marker', async () => {
  const f = await fixture();
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = await readFile(f.log, 'utf8');
    assert.ok(calls.indexOf('writer:') >= 0);
    assert.ok(calls.indexOf('gate:') > calls.indexOf('writer:'));
    assert.ok(calls.indexOf('mount:') > calls.indexOf('gate:'));
    await assert.rejects(lstat(path.join(f.restore, '.vow-restore-pending')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.restore, '.vow-privacy-reconciled'), 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('failed bind mount restores the pending marker and removes the ready marker', async () => {
  const f = await fixture();
  try {
    const result = run(f, { MOUNT_EXIT: '32' });
    assert.notEqual(result.status, 0);
    await lstat(path.join(f.restore, '.vow-restore-pending'));
    await assert.rejects(lstat(path.join(f.restore, '.vow-privacy-reconciled')), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation refuses a staging directory without its pending marker', async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.restore, '.vow-restore-pending'));
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test('restored media cannot be activated when writer isolation fails', async () => {
  const f = await fixture();
  try {
    const result = run(f, { WRITER_GATE_EXIT: '43' });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(f.restore, '.vow-restore-pending'), 'utf8'), '');
    await assert.rejects(lstat(path.join(f.restore, '.vow-privacy-reconciled')), { code: 'ENOENT' });
    const calls = await readFile(f.log, 'utf8');
    assert.ok(calls.includes('writer:'));
    assert.equal(calls.includes('gate:'), false);
    assert.equal(calls.includes('mount:'), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
