import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'privacy-recovery-admission.sh');
const writerUid = 65534;
const writerGid = 65534;
const sudo = process.getuid?.() === 0 ? [] : ['sudo', '-n'];
const rootAvailable = process.getuid?.() === 0 || spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' }).status === 0;
const setprivAvailable = spawnSync('setpriv', ['--version'], { encoding: 'utf8' }).status === 0;
const canRun = rootAvailable && setprivAvailable;

function runRoot(args, options = {}) {
  return spawnSync(...(sudo.length ? ['sudo', ['-n', ...args]] : [args[0], args.slice(1)]), options);
}

async function fixture({ drain = '#!/usr/bin/env bash\\nset -eu\\nexit 0\\n' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-privacy-admission-'));
  const admissionDir = path.join(root, 'admission');
  const lock = path.join(admissionDir, 'writers.lock');
  const drainPath = path.join(root, 'drain');
  const marker = lock + '.maintenance';
  const rootOwner = runRoot(['chown', `0:${writerGid}`, root]);
  assert.equal(rootOwner.status, 0, rootOwner.stderr);
  const rootMode = runRoot(['chmod', '2750', root]);
  assert.equal(rootMode.status, 0, rootMode.stderr);
  const admissionCreate = runRoot(['install', '-d', '-o', '0', '-g', String(writerGid), '-m', '2750', admissionDir]);
  assert.equal(admissionCreate.status, 0, admissionCreate.stderr);
  const lockCreate = runRoot(['install', '-o', '0', '-g', String(writerGid), '-m', '0640', '/dev/null', lock]);
  assert.equal(lockCreate.status, 0, lockCreate.stderr);
  await writeFile(drainPath, drain);
  const drainOwner = runRoot(['chown', '0:0', drainPath]);
  assert.equal(drainOwner.status, 0, drainOwner.stderr);
  const drainMode = runRoot(['chmod', '0755', drainPath]);
  assert.equal(drainMode.status, 0, drainMode.stderr);
  return { root, lock, drainPath, marker };
}

function commandFor(f, mode, command, extra = {}) {
  const env = {
    PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock,
    PRIVACY_RECOVERY_WRITER_GID: String(writerGid),
    PRIVACY_RECOVERY_DRAIN_EXECUTABLE: f.drainPath,
    PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '1',
    ...extra
  };
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  if (mode === 'writer') {
    return [...sudo, 'setpriv', '--reuid', String(writerUid), '--regid', String(writerGid), '--clear-groups', '--', 'env', ...envArgs, 'bash', script, mode, '--', ...command];
  }
  return [...sudo, 'env', ...envArgs, 'bash', script, mode, '--', ...command];
}

function run(f, mode, command, extra = {}) {
  return spawnSync(commandFor(f, mode, command, extra)[0], commandFor(f, mode, command, extra).slice(1), {
    encoding: 'utf8',
    timeout: 5000
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPath(target, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await lstat(target);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error('timed out waiting for writer signal: ' + target);
}

async function cleanup(f) {
  if (!f) return;
  runRoot(['rm', '-rf', '--', f.root]);
}

test('cross-UID admission integration requires root and setpriv', { skip: !canRun }, async t => {
  t.diagnostic('writer runs as UID/GID 65534; lock is root:65534 mode 0640; lock directory is root:65534 mode 2750');

  await t.test('writer rejects admission after the root-owned sticky maintenance marker exists', async () => {
    const f = await fixture();
    try {
      const created = runRoot(['install', '-d', '-o', '0', '-g', String(writerGid), '-m', '2750', f.marker]);
      assert.equal(created.status, 0, created.stderr);
      const result = run(f, 'writer', ['true']);
      assert.equal(result.status, 75, result.stderr);
      assert.match(result.stderr, /admission is closed/);
    } finally {
      await cleanup(f);
    }
  });

  await t.test('unprivileged writer holds shared lock for its complete command lifetime', async () => {
    const f = await fixture();
    let writer;
    const readyFile = `${f.root}.writer-ready`;
    try {
      const args = commandFor(f, 'writer', ['bash', '-c', 'printf ready > "$READY_FILE"; sleep 1'], { READY_FILE: readyFile });
      writer = spawn(args[0], args.slice(1), { stdio: 'ignore' });
      await waitForPath(readyFile);
      const blocked = runRoot(['flock', '-n', '-x', f.lock, '-c', 'true']);
      assert.notEqual(blocked.status, 0, 'root maintenance must not acquire EX while the service writer holds SH');
      await new Promise((resolve, reject) => {
        writer.once('error', reject);
        writer.once('exit', code => code === 0 ? resolve() : reject(new Error('writer exited with ' + code)));
      });
      const available = runRoot(['flock', '-n', '-x', f.lock, '-c', 'true']);
      assert.equal(available.status, 0, available.stderr);
    } finally {
      if (writer && writer.exitCode === null) writer.kill('SIGKILL');
      runRoot(['rm', '-f', '--', readyFile]);
      await cleanup(f);
    }
  });

  await t.test('root maintenance creates a group-visible marker before its critical command', async () => {
    const f = await fixture({
      drain: '#!/usr/bin/env bash\\nset -eu\\ntest -d "$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance"\\n'
        + 'if setpriv --reuid 65534 --regid 65534 --clear-groups -- env PRIVACY_RECOVERY_WRITER_LOCK_FILE="$PRIVACY_RECOVERY_WRITER_LOCK_FILE" PRIVACY_RECOVERY_WRITER_GID="$PRIVACY_RECOVERY_WRITER_GID" bash "' + script + '" writer -- true; then exit 91; else status=$?; fi\\n'
        + 'test "$status" -eq 75\\n'
    });
    const output = path.join(f.root + '.critical-output');
    try {
      const result = run(f, 'maintenance', ['bash', '-c', 'printf activated > "$CRITICAL_OUTPUT"'], { CRITICAL_OUTPUT: output });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(runRoot(['test', '-d', f.marker]).status, 0);
      const markerStat = runRoot(['stat', '-Lc', '%u:%g:%a', f.marker]);
      assert.equal(markerStat.stdout.trim(), `0:${writerGid}:2750`);
      const blocked = run(f, 'writer', ['true']);
      assert.equal(blocked.status, 75, blocked.stderr);
    } finally {
      runRoot(['rm', '-f', '--', output]);
      await cleanup(f);
    }
  });

  await t.test('maintenance failure leaves the sticky marker and never runs critical work', async () => {
    const f = await fixture({ drain: '#!/usr/bin/env bash\\nexit 44\\n' });
    const output = `${f.root}.unsafe-output`;
    try {
      const result = run(f, 'maintenance', ['bash', '-c', 'echo unsafe > "$CRITICAL_OUTPUT"'], { CRITICAL_OUTPUT: output });
      assert.notEqual(result.status, 0);
      assert.equal(runRoot(['test', '-d', f.marker]).status, 0);
      assert.equal(runRoot(['test', '-e', output]).status, 1);
      const blocked = run(f, 'writer', ['true']);
      assert.equal(blocked.status, 75, blocked.stderr);
    } finally {
      await cleanup(f);
    }
  });

  await t.test('root maintenance cannot acquire EX while an unprivileged writer remains active', async () => {
    const f = await fixture();
    let writer;
    const readyFile = `${f.root}.writer-ready`;
    try {
      const args = commandFor(f, 'writer', ['bash', '-c', 'printf ready > "$READY_FILE"; sleep 3'], { READY_FILE: readyFile });
      writer = spawn(args[0], args.slice(1), { stdio: 'ignore' });
      await waitForPath(readyFile);
      const result = run(f, 'maintenance', ['true'], { PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '0.1' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /did not drain/);
      assert.equal(runRoot(['test', '-d', f.marker]).status, 0);
      const blocked = run(f, 'writer', ['true']);
      assert.equal(blocked.status, 75, blocked.stderr);
    } finally {
      if (writer && writer.exitCode === null) writer.kill('SIGKILL');
      await rm(readyFile, { force: true });
      await cleanup(f);
    }
  });
});
