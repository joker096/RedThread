import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, chown, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'backup-private-media.sh');
const admissionScript = path.join(root, 'scripts', 'privacy-recovery-admission.sh');

const sharedGid = 65534;
const writerUid = process.getuid?.() === 0 ? sharedGid : process.getuid();
const writerPrimaryGid = process.getgid?.() === 0 ? sharedGid : process.getgid();
const sudo = process.getuid?.() === 0 ? [] : ['sudo', '-n'];

function rootRun(args, options = {}) {
  return spawnSync(sudo.length ? 'sudo' : args[0], sudo.length ? ['-n', ...args] : args.slice(1), options);
}

function writerArgs(args, env) {
  const vars = Object.entries({
    ...env,
    PRIVACY_RECOVERY_WRITER_LOCK_FILE: env.PRIVACY_RECOVERY_WRITER_LOCK_FILE || env.LOCK_FILE,
    PRIVACY_RECOVERY_WRITER_GID: String(sharedGid)
  }).map(([key, value]) => `${key}=${value}`);
  return [...sudo, 'setpriv', '--reuid', String(writerUid), '--regid', String(writerPrimaryGid),
    '--groups', String(sharedGid), '--', 'env', ...vars, ...args];
}

async function fixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-private-media-backup-'));
  const fakeBin = path.join(temporaryRoot, 'bin');
  const mediaRoot = path.join(temporaryRoot, 'private-media');
  const backupDir = path.join(temporaryRoot, 'backups');
  const lock = path.join(temporaryRoot, 'writers.lock');
  const drain = path.join(temporaryRoot, 'drain');
  await mkdir(fakeBin);
  await mkdir(mediaRoot);
  await writeFile(path.join(mediaRoot, 'private-photo.jpg'), 'fixture-private-photo-content');
  const tar = path.join(fakeBin, 'tar');
  const age = path.join(fakeBin, 'age');
  await writeFile(tar, `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'fixture-archive-with-private-photo-content'
`);
  await writeFile(age, `#!/usr/bin/env bash
set -Eeuo pipefail
output=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
test -n "$output"
input="${output}.input"
cat > "$input"
{ printf 'AGE-ENCRYPTED-FIXTURE:'; sha256sum "$input" | cut -d ' ' -f 1; } > "$output"
rm -f "$input"
`);
  await chmod(tar, 0o750);
  await chmod(age, 0o750);
  await chmod(fakeBin, 0o750);
  await chmod(mediaRoot, 0o750);
  await chown(fakeBin, writerUid, sharedGid);
  await chown(mediaRoot, writerUid, sharedGid);
  await chown(path.join(mediaRoot, 'private-photo.jpg'), writerUid, sharedGid);
  await chown(tar, writerUid, sharedGid);
  await chown(age, writerUid, sharedGid);
  await writeFile(drain, '#!/usr/bin/env bash\\nset -eu\\nexit 0\\n');
  const rootOwner = rootRun(['chown', `0:${sharedGid}`, temporaryRoot]);
  assert.equal(rootOwner.status, 0, rootOwner.stderr);
  const rootMode = rootRun(['chmod', '2750', temporaryRoot]);
  assert.equal(rootMode.status, 0, rootMode.stderr);
  const lockCreate = rootRun(['install', '-o', '0', '-g', String(sharedGid), '-m', '0640', '/dev/null', lock]);
  assert.equal(lockCreate.status, 0, lockCreate.stderr);
  const drainOwner = rootRun(['chown', '0:0', drain]);
  assert.equal(drainOwner.status, 0, drainOwner.stderr);
  const drainMode = rootRun(['chmod', '0755', drain]);
  assert.equal(drainMode.status, 0, drainMode.stderr);
  return { temporaryRoot, fakeBin, mediaRoot, backupDir, lock, drain };
}

function run(env, { direct = false } = {}) {
  const command = direct ? ['bash', script] : ['bash', admissionScript, 'writer', '--', 'bash', script];
  const args = writerArgs(command, env);
  return spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 10000 });
}

async function cleanup(f) {
  rootRun(['rm', '-rf', '--', f.temporaryRoot]);
}

test('private media backup streams archive into age and stores only encrypted output', async () => {
  const f = await fixture();
  try {
    const result = run({
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      PRIVATE_MEDIA_DIR: f.mediaRoot,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient',
      BACKUP_RETENTION_DAYS: '30',
      LOCK_FILE: f.lock,
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock,
      PRIVACY_RECOVERY_WRITER_GID: String(sharedGid)
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const files = await readdir(f.backupDir);
    const archiveName = files.find(name => name.endsWith('.tar.age'));
    assert.ok(archiveName);
    assert.ok(files.includes(`${archiveName}.sha256`));
    assert.equal(files.some(name => name.endsWith('.tmp') || name.endsWith('.input')), false);
    const encrypted = await readFile(path.join(f.backupDir, archiveName), 'utf8');
    assert.ok(encrypted.startsWith('AGE-ENCRYPTED-FIXTURE:'));
    assert.equal(encrypted.includes('fixture-archive-with-private-photo-content'), false);
    assert.equal((await stat(path.join(f.backupDir, archiveName))).mode & 0o777, 0o600);
    assert.equal((await stat(f.backupDir)).mode & 0o777, 0o700);
    const checksum = spawnSync('sha256sum', ['--check', path.join(f.backupDir, `${archiveName}.sha256`)], { encoding: 'utf8' });
    assert.equal(checksum.status, 0, checksum.stderr || checksum.stdout);
  } finally {
    await cleanup(f);
  }
});

test('private media backup refuses symlink roots and symlinks inside the media tree', async () => {
  const f = await fixture();
  try {
    const rootLink = path.join(f.temporaryRoot, 'media-link');
    await symlink(f.mediaRoot, rootLink);
    const baseEnv = {
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient',
      LOCK_FILE: f.lock
    };
    const rootResult = run({ ...baseEnv, PRIVATE_MEDIA_DIR: rootLink });
    assert.notEqual(rootResult.status, 0);
    await symlink(path.join(f.temporaryRoot, 'outside'), path.join(f.mediaRoot, 'external-link'));
    const nestedResult = run({ ...baseEnv, PRIVATE_MEDIA_DIR: f.mediaRoot });
    assert.notEqual(nestedResult.status, 0);
    assert.deepEqual(await readdir(f.backupDir).catch(() => []), []);
  } finally {
    await rm(f.temporaryRoot, { recursive: true, force: true });
  }
});

test('private media backup refuses FIFOs and other special filesystem entries', async () => {
  const f = await fixture();
  try {
    const fifo = path.join(f.mediaRoot, 'unexpected-pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr || 'mkfifo is required for this test');
    const result = run({
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      PRIVATE_MEDIA_DIR: f.mediaRoot,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient',
      LOCK_FILE: f.lock
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /special filesystem entries/);
    assert.deepEqual(await readdir(f.backupDir).catch(() => []), []);
  } finally {
    await rm(f.temporaryRoot, { recursive: true, force: true });
  }
});

test('private media backup fails closed when encryption recipient is absent', async () => {
  const f = await fixture();
  try {
    const result = run({
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      PRIVATE_MEDIA_DIR: f.mediaRoot,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: '',
      LOCK_FILE: f.lock
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(f.backupDir).catch(() => []), []);
  } finally {
    await rm(f.temporaryRoot, { recursive: true, force: true });
  }
});

test('private media backup rejects direct invocation without an admitted shared lock', async () => {
  const f = await fixture();
  try {
    const result = run({
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      PRIVATE_MEDIA_DIR: f.mediaRoot,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient',
      LOCK_FILE: f.lock
    }, { direct: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires the inherited admission lock/);
    assert.deepEqual(await readdir(f.backupDir).catch(() => []), []);
  } finally {
    await rm(f.temporaryRoot, { recursive: true, force: true });
  }
});

test('maintenance cannot overtake an admitted backup reader', async () => {
  const f = await fixture();
  let backup;
  try {
    const started = path.join(f.temporaryRoot, 'tar-started');
    const release = path.join(f.temporaryRoot, 'tar-release');
    await writeFile(path.join(f.fakeBin, 'tar'), `#!/usr/bin/env bash
set -Eeuo pipefail
printf started > "$TAR_STARTED"
while [[ ! -e "$TAR_RELEASE" ]]; do sleep 0.01; done
printf 'fixture-archive-with-private-photo-content'
`);
    await chmod(path.join(f.fakeBin, 'tar'), 0o700);
    const env = {
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      PRIVATE_MEDIA_DIR: f.mediaRoot,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient',
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock,
      PRIVACY_RECOVERY_WRITER_GID: String(sharedGid),
      TAR_STARTED: started,
      TAR_RELEASE: release
    };
    const backupArgs = writerArgs(['bash', admissionScript, 'writer', '--', 'bash', script], env);
    backup = spawn(backupArgs[0], backupArgs.slice(1), { stdio: 'ignore' });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await access(started); break; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await access(started);
    const maintenanceEnv = Object.entries({
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: f.lock,
      PRIVACY_RECOVERY_WRITER_GID: String(sharedGid),
      PRIVACY_RECOVERY_DRAIN_EXECUTABLE: f.drain,
      PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS: '0.2'
    }).map(([key, value]) => `${key}=${value}`);
    const maintenanceArgs = [...sudo, 'env', ...maintenanceEnv, 'bash', admissionScript, 'maintenance', '--', 'true'];
    const maintenance = spawnSync(maintenanceArgs[0], maintenanceArgs.slice(1), {
      encoding: 'utf8',
      timeout: 3000
    });
    assert.notEqual(maintenance.status, 0, maintenance.stderr || 'maintenance must wait for backup reader');
    assert.match(maintenance.stderr, /did not drain/);
    await writeFile(release, 'release');
    await new Promise((resolve, reject) => {
      backup.once('error', reject);
      backup.once('exit', code => code === 0 ? resolve() : reject(new Error('backup exited with ' + code)));
    });
    await access(f.lock + '.maintenance');
    const files = await readdir(f.backupDir);
    assert.ok(files.some(name => name.endsWith('.tar.age')));
  } finally {
    if (backup && backup.exitCode === null) backup.kill('SIGKILL');
    await rm(f.temporaryRoot, { recursive: true, force: true });
  }
});
