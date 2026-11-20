import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const script = new URL('./activate-private-media-restore.sh', import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-private-media-activation-'));
  const bin = path.join(root, 'bin');
  const restore = path.join(root, 'restored');
  const mountpoint = path.join(root, 'mountpoint');
  const gate = path.join(root, 'privacy-gate');
  const writerGate = path.join(root, 'writer-isolation-gate');
  const writerLock = path.join(root, 'writer-admission.lock');
  const drain = path.join(root, 'drain-writers');
  const admission = new URL('./privacy-recovery-admission.sh', import.meta.url).pathname;
  const log = path.join(root, 'calls.log');
  await Promise.all([mkdir(bin), mkdir(restore), mkdir(mountpoint)]);
  await writeFile(path.join(restore, 'photo.fixture'), 'private');
  await writeFile(path.join(restore, '.vow-restore-pending'), '');
  await chmod(path.join(restore, '.vow-restore-pending'), 0o600);
  await writeFile(log, '');
  await writeFile(writerLock, '');
  await chmod(writerLock, 0o600);
  await writeFile(drain, '#!/usr/bin/env bash\nset -eu\nprintf "drain\\n" >> "$CALL_LOG"\ntest -d "$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance"\n');
  await chmod(drain, 0o700);
  await writeFile(gate, '#!/usr/bin/env bash\nset -eu\ntest "$PRIVACY_RECOVERY_WRITER_LOCK_FD" = 9\ntest -e "/proc/self/fd/$PRIVACY_RECOVERY_WRITER_LOCK_FD"\nif flock -n "$PRIVACY_RECOVERY_WRITER_LOCK_FILE" -c true; then echo "writer lock was not held during domain gate" >&2; exit 91; fi\nprintf "gate:%s\\n" "$RESTORE_DESTINATION" >> "$CALL_LOG"\nexit "${GATE_EXIT:-0}"\n');
  await chmod(gate, 0o700);
  await writeFile(writerGate, '#!/usr/bin/env bash\nset -eu\ntest "$PRIVACY_RECOVERY_WRITER_LOCK_FD" = 9\ntest -e "/proc/self/fd/$PRIVACY_RECOVERY_WRITER_LOCK_FD"\nif flock -n "$PRIVACY_RECOVERY_WRITER_LOCK_FILE" -c true; then echo "writer lock was not held during writer gate" >&2; exit 92; fi\nprintf "writer:%s\\n" "$RESTORE_DESTINATION" >> "$CALL_LOG"\nexit "${WRITER_GATE_EXIT:-0}"\n');
  await writeFile(path.join(bin, 'mountpoint'), '#!/usr/bin/env bash\n[[ -f "$MOUNT_STATE" ]]\n');
  await chmod(path.join(bin, 'mountpoint'), 0o700);
  await writeFile(path.join(bin, 'mount'), '#!/usr/bin/env bash\nset -eu\nprintf "mount:%s\\n" "$*" >> "$CALL_LOG"\nif [[ "${MOUNT_NOOP:-false}" != true && "${MOUNT_EXIT:-0}" == 0 ]]; then : > "$MOUNT_STATE"; fi\nexit "${MOUNT_EXIT:-0}"\n');
  await chmod(path.join(bin, 'mount'), 0o700);
  await writeFile(path.join(bin, 'umount'), '#!/usr/bin/env bash\nset -eu\nprintf "umount:%s\\n" "$*" >> "$CALL_LOG"\nexit "${UMOUNT_EXIT:-0}"\n');
  await chmod(path.join(bin, 'umount'), 0o700);
  return { root, bin, restore, mountpoint, gate, writerGate, writerLock, drain, admission, log, mountState: path.join(root, 'mounted.state') };
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
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.writerLock,
      PRIVACY_RECOVERY_ADMISSION_EXECUTABLE: f.admission,
      PRIVACY_RECOVERY_DRAIN_EXECUTABLE: f.drain,
      PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '0.2',
      ADMISSION_HELPER: f.admission,
      CALL_LOG: f.log,
      MOUNT_STATE: f.mountState,
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

test('activation keeps admission closed when the drain controller fails', async () => {
  const f = await fixture();
  try {
    await writeFile(f.drain, '#!/usr/bin/env bash\nexit 44\n');
    await chmod(f.drain, 0o700);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /drain|44/i);
    await lstat(f.writerLock + '.maintenance');
    await lstat(path.join(f.restore, '.vow-restore-pending'));
    assert.equal((await readFile(f.log, 'utf8')).includes('writer:'), false);
    assert.equal((await readFile(f.log, 'utf8')).includes('mount:'), false);
    const denied = spawnSync('bash', [f.admission, 'writer', '--', 'true'], {
      encoding: 'utf8',
      env: { ...process.env, PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.writerLock }
    });
    assert.equal(denied.status, 75, denied.stderr);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('restored media is mounted only after the gate succeeds and receives a reconciliation marker', async () => {
  const f = await fixture();
  try {
    const result = run(f, { PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '2' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = await readFile(f.log, 'utf8');
    assert.ok(calls.indexOf('drain\n') >= 0);
    assert.ok(calls.indexOf('writer:') > calls.indexOf('drain\n'));
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


test('activation rejects a symlink writer-admission lock file', async () => {
  const f = await fixture();
  const link = path.join(f.root, 'writer-admission-link');
  try {
    await rm(f.writerLock);
    await import('node:fs/promises').then(({ symlink }) => symlink(path.join(f.root, 'target-lock'), link));
    await writeFile(path.join(f.root, 'target-lock'), '');
    const result = run(f, { PRIVACY_RECOVERY_WRITER_LOCK_FILE: link });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pre-created regular non-symlink file/);
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation rejects a writer lock accessible to group or others', async () => {
  const f = await fixture();
  try {
    await chmod(f.writerLock, 0o640);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /owned by the activating user and inaccessible to group\/others/);
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation refuses a writer-admission lock already held by another process', async () => {
  const f = await fixture();
  try {
    const result = spawnSync('flock', ['-n', f.writerLock, 'bash', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH || ''}`,
        RESTORE_DESTINATION: f.restore,
        PRIVATE_MEDIA_MOUNTPOINT: f.mountpoint,
        PRIVACY_RECOVERY_GATE_EXECUTABLE: f.gate,
        PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE: f.writerGate,
        PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.writerLock,
        PRIVACY_RECOVERY_ADMISSION_EXECUTABLE: f.admission,
        PRIVACY_RECOVERY_DRAIN_EXECUTABLE: f.drain,
        PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '0.1',
        ADMISSION_HELPER: f.admission,
        CALL_LOG: f.log
      }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /writer admission locks did not drain/);
    assert.equal(await readFile(f.log, 'utf8'), 'drain\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('interrupted bind activation leaves a durable incomplete marker and cannot be retried', async () => {
  const f = await fixture();
  try {
    const mountScript = path.join(f.bin, 'mount');
    await writeFile(mountScript, '#!/usr/bin/env bash\nkill -TERM "$PPID"\nsleep 1\nexit 0\n');
    await chmod(mountScript, 0o700);
    const interrupted = run(f);
    assert.equal(interrupted.signal, 'SIGTERM');
    await lstat(path.join(f.restore, '.vow-privacy-activation-incomplete'));
    await assert.rejects(lstat(path.join(f.restore, '.vow-restore-pending')), { code: 'ENOENT' });
    await lstat(path.join(f.restore, '.vow-privacy-reconciled'));

    const retry = run(f);
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /missing, incomplete, or has already been activated/);
    await lstat(path.join(f.restore, '.vow-privacy-activation-incomplete'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test('activation rejects a dangling reconciled-marker symlink', async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.restore, '.vow-restore-pending'));
    await import('node:fs/promises').then(({ symlink }) => symlink(path.join(f.root, 'missing-target'), path.join(f.restore, '.vow-privacy-reconciled')));
    await writeFile(path.join(f.restore, '.vow-restore-pending'), '');
    await chmod(path.join(f.restore, '.vow-restore-pending'), 0o600);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing, incomplete, or has already been activated/);
    await assert.rejects(lstat(path.join(f.root, 'missing-target')), { code: 'ENOENT' });
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation rejects a dangling incomplete-marker symlink', async () => {
  const f = await fixture();
  try {
    await import('node:fs/promises').then(({ symlink }) => symlink(path.join(f.root, 'missing-incomplete-target'), path.join(f.restore, '.vow-privacy-activation-incomplete')));
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing, incomplete, or has already been activated/);
    await assert.rejects(lstat(path.join(f.root, 'missing-incomplete-target')), { code: 'ENOENT' });
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});



test('activation rejects a staging directory reached through a symlinked parent', async () => {
  const f = await fixture();
  const parentLink = path.join(f.root, 'restore-parent-link');
  try {
    await import('node:fs/promises').then(({ symlink }) => symlink(f.root, parentLink, 'dir'));
    const linkedDestination = path.join(parentLink, 'restored');
    const result = run(f, { RESTORE_DESTINATION: linkedDestination });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked or non-canonical path components/);
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation rejects a pending marker with multiple hard links', async () => {
  const f = await fixture();
  const alias = path.join(f.root, 'pending-marker-alias');
  try {
    await import('node:fs/promises').then(({ link }) => link(path.join(f.restore, '.vow-restore-pending'), alias));
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one hard link/);
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation rejects a pending marker with permissive mode', async () => {
  const f = await fixture();
  try {
    await chmod(path.join(f.restore, '.vow-restore-pending'), 0o644);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mode 0600/);
    assert.equal(await readFile(f.log, 'utf8'), '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test('sync failures at every activation durability barrier preserve a blocking marker', async () => {
  for (const failAt of [1, 2, 3, 4, 5]) {
    const f = await fixture();
    try {
      const realSync = spawnSync('bash', ['-c', 'command -v sync'], { encoding: 'utf8' }).stdout.trim();
      assert.ok(realSync, 'sync executable must be available');
      const countFile = path.join(f.root, 'sync-count');
      const syncShim = path.join(f.bin, 'sync');
      await writeFile(syncShim, [
        '#!/usr/bin/env bash',
        'set -eu',
        '"$REAL_SYNC" "$@"',
        'case "$*" in *"$RESTORE_DESTINATION"*) ;; *) exit 0 ;; esac',
        'count=0',
        'if [[ -f "$SYNC_COUNT_FILE" ]]; then read -r count < "$SYNC_COUNT_FILE"; fi',
        'count=$((count + 1))',
        'printf "%s\\n" "$count" > "$SYNC_COUNT_FILE"',
        'if [[ "$count" -eq "$SYNC_FAIL_AT" ]]; then exit 77; fi',
        'exit 0',
        ''
      ].join('\n'));
      await chmod(syncShim, 0o700);
      const result = run(f, {
        REAL_SYNC: realSync,
        SYNC_COUNT_FILE: countFile,
        SYNC_FAIL_AT: String(failAt)
      });
      assert.notEqual(result.status, 0, 'sync failure must fail activation at barrier ' + failAt);
      await lstat(path.join(f.restore, '.vow-privacy-activation-incomplete'));
      if (failAt <= 2) {
        await lstat(path.join(f.restore, '.vow-restore-pending'));
        assert.equal((await readFile(f.log, 'utf8')).includes('mount:'), false);
      } else {
        await lstat(path.join(f.restore, '.vow-privacy-reconciled'));
        await assert.rejects(lstat(path.join(f.restore, '.vow-restore-pending')), { code: 'ENOENT' });
        if (failAt <= 4) assert.equal((await readFile(f.log, 'utf8')).includes('mount:'), false);
        else assert.ok((await readFile(f.log, 'utf8')).includes('mount:'));
        if (failAt === 5) assert.ok((await readFile(f.log, 'utf8')).includes('umount:'));
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('failed final sync plus failed bind-mount rollback remains explicitly blocked for manual isolation', async () => {
  const f = await fixture();
  try {
    const realSync = spawnSync('bash', ['-c', 'command -v sync'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(realSync, 'sync executable must be available');
    const countFile = path.join(f.root, 'sync-count');
    const syncShim = path.join(f.bin, 'sync');
    await writeFile(syncShim, [
      '#!/usr/bin/env bash',
      'set -eu',
      '"$REAL_SYNC" "$@"',
      'case "$*" in *"$RESTORE_DESTINATION"*) ;; *) exit 0 ;; esac',
      'count=0',
      'if [[ -f "$SYNC_COUNT_FILE" ]]; then read -r count < "$SYNC_COUNT_FILE"; fi',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" > "$SYNC_COUNT_FILE"',
      'if [[ "$count" -eq "$SYNC_FAIL_AT" ]]; then exit 77; fi',
      'exit 0',
      ''
    ].join('\n'));
    await chmod(syncShim, 0o700);

    const result = run(f, {
      REAL_SYNC: realSync,
      SYNC_COUNT_FILE: countFile,
      SYNC_FAIL_AT: '5',
      UMOUNT_EXIT: '44'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bind-mount rollback also failed; manual isolation is required/);
    assert.match(result.stderr, /activation was rolled back where possible and remains blocked/);
    const calls = await readFile(f.log, 'utf8');
    assert.ok(calls.includes('mount:'));
    assert.ok(calls.includes('umount:'));
    const marker = await lstat(path.join(f.restore, '.vow-privacy-activation-incomplete'));
    assert.equal(marker.mode & 0o777, 0o600);
    assert.ok(marker.nlink === 1);
    await lstat(path.join(f.restore, '.vow-privacy-reconciled'));
    await assert.rejects(lstat(path.join(f.restore, '.vow-restore-pending')), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test('termination during final directory sync restores the incomplete marker', async () => {
  const f = await fixture();
  try {
    const realSync = spawnSync('bash', ['-c', 'command -v sync'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(realSync, 'sync executable must be available');
    const countFile = path.join(f.root, 'sync-count');
    const syncShim = path.join(f.bin, 'sync');
    await writeFile(syncShim, [
      '#!/usr/bin/env bash',
      'set -eu',
      'case "$*" in *"$RESTORE_DESTINATION"*) ;; *) "$REAL_SYNC" "$@"; exit 0 ;; esac',
      'count=0',
      'if [[ -f "$SYNC_COUNT_FILE" ]]; then read -r count < "$SYNC_COUNT_FILE"; fi',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" > "$SYNC_COUNT_FILE"',
      'if [[ "$count" -eq 5 ]]; then kill -TERM "$PPID"; exit 0; fi',
      '"$REAL_SYNC" "$@"',
      'exit 0',
      ''
    ].join('\n'));
    await chmod(syncShim, 0o700);

    const result = run(f, {
      REAL_SYNC: realSync,
      SYNC_COUNT_FILE: countFile
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /activation interrupted by TERM; incomplete marker restored and activation remains blocked/);
    const marker = await lstat(path.join(f.restore, '.vow-privacy-activation-incomplete'));
    assert.equal(marker.mode & 0o777, 0o600);
    await lstat(path.join(f.restore, '.vow-privacy-reconciled'));
    await assert.rejects(lstat(path.join(f.restore, '.vow-restore-pending')), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('activation refuses a mount command that exits successfully without mounting the target', async () => {
  const f = await fixture();
  try {
    const result = run(f, { MOUNT_NOOP: 'true' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mount command returned success but the private media target is not mounted/);
    await lstat(path.join(f.restore, '.vow-privacy-activation-incomplete'));
    await lstat(path.join(f.restore, '.vow-privacy-reconciled'));
    await assert.rejects(lstat(path.join(f.restore, '.vow-restore-pending')), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('activation closes writer admission before draining and waits for an already admitted writer', async () => {
  const f = await fixture();
  let writer;
  try {
    const ready = path.join(f.root, 'admitted-writer.ready');
    writer = spawn('bash', [f.admission, 'writer', '--', 'bash', '-c', 'printf ready > "$READY_FILE"; sleep 0.35'], {
      env: { ...process.env, PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.writerLock, READY_FILE: ready },
      stdio: 'ignore'
    });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await lstat(ready); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await lstat(ready);
    const result = run(f, { PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '2' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = await readFile(f.log, 'utf8');
    assert.ok(calls.indexOf('drain\n') >= 0);
    assert.ok(calls.indexOf('writer:') > calls.indexOf('drain\n'));
    assert.ok(calls.indexOf('mount:') > calls.indexOf('writer:'));
    await lstat(f.writerLock + '.maintenance');
    const denied = spawnSync('bash', [f.admission, 'writer', '--', 'true'], {
      encoding: 'utf8',
      env: { ...process.env, PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.writerLock }
    });
    assert.equal(denied.status, 75, denied.stderr);
  } finally {
    if (writer && writer.exitCode === null) writer.kill('SIGKILL');
    await rm(f.root, { recursive: true, force: true });
  }
});

