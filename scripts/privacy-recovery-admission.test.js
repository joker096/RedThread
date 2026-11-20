import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'privacy-recovery-admission.sh');
const writerUid = process.getuid?.() ?? 1000;
const writerPrimaryGid = process.getgid?.() ?? writerUid;
const writerGid = 65534;
const sudo = process.getuid?.() === 0 ? [] : ['sudo', '-n'];
const rootAvailable = process.getuid?.() === 0 || spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' }).status === 0;
const setprivAvailable = spawnSync('setpriv', ['--version'], { encoding: 'utf8' }).status === 0;
const canRun = rootAvailable && setprivAvailable && writerUid !== 0;

function runRoot(args, options = {}) {
  return spawnSync(...(sudo.length ? ['sudo', ['-n', ...args]] : [args[0], args.slice(1)]), { encoding: 'utf8', ...options });
}

async function fixture({ drain = `#!/usr/bin/env bash
set -eu
exit 0
` } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-privacy-admission-'));
  const admissionDir = path.join(root, 'admission');
  const lock = path.join(admissionDir, 'writers.lock');
  const drainPath = path.join(root, 'drain');
  const marker = lock + '.maintenance';
  await writeFile(drainPath, drain);
  const rootOwner = runRoot(['chown', `0:${writerGid}`, root]);
  assert.equal(rootOwner.status, 0, rootOwner.stderr);
  const rootMode = runRoot(['chmod', '2750', root]);
  assert.equal(rootMode.status, 0, rootMode.stderr);
  const admissionCreate = runRoot(['install', '-d', '-o', '0', '-g', String(writerGid), '-m', '2750', admissionDir]);
  assert.equal(admissionCreate.status, 0, admissionCreate.stderr);
  const lockCreate = runRoot(['install', '-o', '0', '-g', String(writerGid), '-m', '0640', '/dev/null', lock]);
  assert.equal(lockCreate.status, 0, lockCreate.stderr);
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
    return [...sudo, 'setpriv', '--reuid', String(writerUid), '--regid', String(writerPrimaryGid), '--groups', String(writerGid), '--', 'env', ...envArgs, 'bash', script, mode, '--', ...command];
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
  t.diagnostic(`writer runs as unprivileged UID ${writerUid} with supplementary GID ${writerGid}; lock is root:${writerGid} mode 0640; lock directory is root:${writerGid} mode 2750`);

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
      drain: `#!/usr/bin/env bash
set -eu
test -d "$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance"
if setpriv --reuid ${writerUid} --regid ${writerPrimaryGid} --groups ${writerGid} -- env PRIVACY_RECOVERY_WRITER_LOCK_FILE="$PRIVACY_RECOVERY_WRITER_LOCK_FILE" PRIVACY_RECOVERY_WRITER_GID="$PRIVACY_RECOVERY_WRITER_GID" bash "${script}" writer -- true; then exit 91; else status=$?; fi
test "$status" -eq 75
`
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
    const f = await fixture({ drain: `#!/usr/bin/env bash
exit 44
` });
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
      runRoot(['rm', '-f', '--', readyFile]);
      await cleanup(f);
    }
  });
  await t.test('rejects malformed numeric writer GIDs before opening the lock', async () => {
    const f = await fixture();
    try {
      for (const invalidGid of ['0', '-1', '65534x', '1.5']) {
        const result = run(f, 'writer', ['true'], { PRIVACY_RECOVERY_WRITER_GID: invalidGid });
        assert.equal(result.status, 1, `unexpected result for GID ${JSON.stringify(invalidGid)}: ${result.stderr}`);
        assert.match(result.stderr, /writer group ID must be a positive numeric GID/);
      }
    } finally {
      await cleanup(f);
    }
  });

  await t.test('rejects a writer whose supplementary groups omit the configured GID', async () => {
    const f = await fixture();
    try {
      const env = {
        PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock,
        PRIVACY_RECOVERY_WRITER_GID: String(writerGid),
        PRIVACY_RECOVERY_DRAIN_EXECUTABLE: f.drainPath,
        PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '1'
      };
      const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
      const args = [...sudo, 'setpriv', '--reuid', String(writerUid), '--regid', String(writerPrimaryGid),
        '--groups', '65533', '--', 'env', ...envArgs, 'bash', script, 'writer', '--', 'true'];
      const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 5000 });
      assert.notEqual(result.status, 0, 'a process without the configured group must not enter writer admission');
    } finally {
      await cleanup(f);
    }
  });

  await t.test('rejects a symlink substituted for the lock file', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'alternate-lock');
    try {
      const created = runRoot(['install', '-o', '0', '-g', String(writerGid), '-m', '0640', '/dev/null', target]);
      assert.equal(created.status, 0, created.stderr);
      const removed = runRoot(['rm', '-f', '--', f.lock]);
      assert.equal(removed.status, 0, removed.stderr);
      const linked = runRoot(['ln', '-s', '--', target, f.lock]);
      assert.equal(linked.status, 0, linked.stderr);
      const result = run(f, 'writer', ['true']);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /absolute regular non-symlink file/);
    } finally {
      await cleanup(f);
    }
  });

  await t.test('rejects a symlinked maintenance marker instead of treating it as an ordinary marker', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'marker-target');
    try {
      const created = runRoot(['install', '-d', '-o', '0', '-g', String(writerGid), '-m', '2750', target]);
      assert.equal(created.status, 0, created.stderr);
      const linked = runRoot(['ln', '-s', '--', target, f.marker]);
      assert.equal(linked.status, 0, linked.stderr);
      const result = run(f, 'writer', ['true']);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /maintenance marker must not be a symlink/);
    } finally {
      await cleanup(f);
    }
  });

  await t.test('rejects lock inode replacement between initial stat and descriptor open', async () => {
    const f = await fixture();
    const binDir = await mkdtemp(path.join(os.tmpdir(), 'vow-privacy-admission-bin-'));
    const statWrapper = path.join(binDir, 'stat');
    const replacement = path.join(path.dirname(f.lock), 'replacement-lock');
    const swappedFlag = path.join(binDir, 'swapped');
    try {
      const created = runRoot(['install', '-o', '0', '-g', String(writerGid), '-m', '0640', '/dev/null', replacement]);
      assert.equal(created.status, 0, created.stderr);
      await writeFile(statWrapper, `#!/usr/bin/env bash
set -eu
/usr/bin/stat "$@"
if [[ "$*" == *"$LOCK_PATH"* && ! -e "$SWAPPED_FLAG" ]]; then
  /usr/bin/sudo -n mv -- "$REPLACEMENT_LOCK" "$LOCK_PATH"
  : > "$SWAPPED_FLAG"
fi
`);
      const owner = runRoot(['chown', '0:0', statWrapper]);
      assert.equal(owner.status, 0, owner.stderr);
      const executable = runRoot(['chmod', '0755', statWrapper]);
      assert.equal(executable.status, 0, executable.stderr);
      const result = run(f, 'writer', ['true'], {
        PATH: `${binDir}:/usr/bin:/bin`,
        LOCK_PATH: f.lock,
        REPLACEMENT_LOCK: replacement,
        SWAPPED_FLAG: swappedFlag
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /lock changed while opening/);
      assert.equal(runRoot(['test', '-f', f.lock]).status, 0);
      assert.equal(runRoot(['test', '-e', replacement]).status, 1);
    } finally {
      await cleanup(f);
      await rm(binDir, { recursive: true, force: true });
    }
  });

});
