import test from 'node:test';
import { createHash } from 'node:crypto';
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
  const log = path.join(root, 'calls.log');
  await Promise.all([mkdir(bin), mkdir(restore), mkdir(mountpoint)]);
  await writeFile(path.join(restore, 'photo.fixture'), 'private');
  await writeFile(path.join(restore, '.vow-restore-pending'), '');
  await writeFile(log, '');
  const proof = JSON.stringify({
    barrier_id: '123e4567-e89b-42d3-a456-426614174010',
    ledger_sequence: 17,
    signature: 'synthetic-test-proof'
  }) + '\n';
  const proofDigest = createHash('sha256').update(proof).digest('hex');
  await writeFile(path.join(restore, '.vow-snapshot-barrier-proof.json'), proof, { mode: 0o600 });
  const manifest = [
    'format=vow-backup-bundle-v3',
    'snapshot_id=test-snapshot',
    'snapshot_consistency=atomic',
    'snapshot_ledger_sequence=17',
    'snapshot_barrier_id=123e4567-e89b-42d3-a456-426614174010',
    'snapshot_barrier_proof_sha256=' + proofDigest,
    'postgres_archive=postgres/vow-postgres-test-snapshot.dump.age',
    'postgres_sha256=' + 'a'.repeat(64),
    'private_media_archive=private-media/vow-private-media-test-snapshot.tar.age',
    'private_media_sha256=' + 'b'.repeat(64)
  ].join('\n') + '\n';
  await writeFile(path.join(restore, '.vow-backup-manifest'), manifest, { mode: 0o600 });
  const manifestDigest = createHash('sha256').update(manifest).digest('hex');
  await writeFile(path.join(restore, '.vow-backup-manifest.sha256'), manifestDigest + '  .vow-backup-manifest\n', { mode: 0o600 });
  await writeFile(gate, '#!/usr/bin/env bash\nset -eu\nprintf "gate:%s:%s\\n" "$RESTORE_DESTINATION" "$PRIVACY_RECOVERY_SNAPSHOT_LEDGER_SEQUENCE" >> "$CALL_LOG"\nexit "${GATE_EXIT:-0}"\n');
  await chmod(gate, 0o700);
  await writeFile(path.join(bin, 'mountpoint'), '#!/usr/bin/env bash\nexit 1\n');
  await chmod(path.join(bin, 'mountpoint'), 0o700);
  await writeFile(path.join(bin, 'mount'), '#!/usr/bin/env bash\nset -eu\nprintf "mount:%s\\n" "$*" >> "$CALL_LOG"\nexit "${MOUNT_EXIT:-0}"\n');
  await chmod(path.join(bin, 'mount'), 0o700);
  return { root, bin, restore, mountpoint, gate, log };
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
    assert.ok(calls.includes(`gate:${f.restore}:17`));
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


test('activation refuses a best-effort v2 bundle even when the external gate would succeed', async () => {
  const f = await fixture();
  try {
    const manifest = [
      'format=vow-backup-bundle-v2',
      'snapshot_id=test-snapshot',
      'snapshot_consistency=best_effort_non_atomic',
      'postgres_archive=postgres/vow-postgres-test-snapshot.dump.age',
      'postgres_sha256=' + 'a'.repeat(64),
      'private_media_archive=private-media/vow-private-media-test-snapshot.tar.age',
      'private_media_sha256=' + 'b'.repeat(64)
    ].join('\\n') + '\\n';
    await writeFile(path.join(f.restore, '.vow-backup-manifest'), manifest);
    const digest = createHash('sha256').update(manifest).digest('hex');
    await writeFile(path.join(f.restore, '.vow-backup-manifest.sha256'), digest + '  .vow-backup-manifest\\n');
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only explicitly atomic v3 backup bundles can be activated/);
    assert.equal(await readFile(f.log, 'utf8'), '');
    await lstat(path.join(f.restore, '.vow-restore-pending'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation refuses a snapshot barrier proof whose digest differs from the manifest', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.restore, '.vow-snapshot-barrier-proof.json'), '{"tampered":true}\\n');
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /snapshot barrier proof checksum does not match/);
    assert.equal(await readFile(f.log, 'utf8'), '');
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
