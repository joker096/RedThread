import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const script = new URL('./privacy-recovery-admission.sh', import.meta.url).pathname;

async function fixture({ drain = '#!/usr/bin/env bash\nset -eu\nexit 0\n' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-privacy-admission-'));
  const lock = path.join(root, 'writers.lock');
  const drainPath = path.join(root, 'drain');
  const log = path.join(root, 'critical.log');
  await writeFile(lock, '');
  await chmod(lock, 0o600);
  await writeFile(drainPath, drain);
  await chmod(drainPath, 0o700);
  return { root, lock, drainPath, log, marker: lock + '.maintenance' };
}

function run(f, mode, command, extra = {}) {
  return spawnSync('bash', [script, mode, '--', ...command], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock,
      PRIVACY_RECOVERY_DRAIN_EXECUTABLE: f.drainPath,
      PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '1',
      ...extra
    }
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('writer rejects admission after the sticky maintenance marker exists', async () => {
  const f = await fixture();
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(f.marker, { mode: 0o700 });
    const result = run(f, 'writer', ['true']);
    assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /admission is closed/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('writer retains its shared lock for the complete command lifetime', async () => {
  const f = await fixture();
  let writer;
  try {
    writer = spawn('bash', [script, 'writer', '--', 'sleep', '0.7'], {
      env: { ...process.env, PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock },
      stdio: 'ignore'
    });
    await delay(120);
    const exclusive = spawnSync('flock', ['-n', '-x', f.lock, '-c', 'true'], { encoding: 'utf8' });
    assert.notEqual(exclusive.status, 0, 'exclusive lock must be blocked while writer command is alive');
    await new Promise((resolve, reject) => {
      writer.once('error', reject);
      writer.once('exit', code => code === 0 ? resolve() : reject(new Error('writer exited with ' + code)));
    });
    const after = spawnSync('flock', ['-n', '-x', f.lock, '-c', 'true'], { encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
  } finally {
    if (writer && writer.exitCode === null) writer.kill('SIGKILL');
    await rm(f.root, { recursive: true, force: true });
  }
});

test('maintenance closes admission before drain and retains marker after critical command', async () => {
  const f = await fixture({
    drain: '#!/usr/bin/env bash\nset -eu\ntest -d "$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance"\n'
      + 'if bash "$ADMISSION_SCRIPT" writer -- true; then exit 91; else status=$?; fi\n'
      + 'test "$status" -eq 75\n'
  });
  try {
    const result = run(f, 'maintenance', ['bash', '-c', 'printf activated > "$CRITICAL_LOG"'], {
      ADMISSION_SCRIPT: script,
      CRITICAL_LOG: f.log
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(f.log, 'utf8'), 'activated');
    const marker = await lstat(f.marker);
    assert.ok(marker.isDirectory());
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('maintenance failure leaves admission closed and never runs the critical command', async () => {
  const f = await fixture({ drain: '#!/usr/bin/env bash\nexit 44\n' });
  try {
    const result = run(f, 'maintenance', ['bash', '-c', 'echo unsafe > "$CRITICAL_LOG"'], {
      CRITICAL_LOG: f.log
    });
    assert.notEqual(result.status, 0);
    await lstat(f.marker);
    await assert.rejects(readFile(f.log, 'utf8'), { code: 'ENOENT' });
    const blocked = run(f, 'writer', ['true']);
    assert.equal(blocked.status, 75);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('maintenance does not acquire EX lock while an existing writer remains active', async () => {
  const f = await fixture();
  let writer;
  try {
    writer = spawn('bash', [script, 'writer', '--', 'sleep', '3'], {
      env: { ...process.env, PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock },
      stdio: 'ignore'
    });
    await delay(120);
    const result = run(f, 'maintenance', ['true'], {
      PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '0.1'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not drain/);
    await lstat(f.marker);
    const blocked = run(f, 'writer', ['true']);
    assert.equal(blocked.status, 75);
  } finally {
    if (writer && writer.exitCode === null) writer.kill('SIGKILL');
    await rm(f.root, { recursive: true, force: true });
  }
});
