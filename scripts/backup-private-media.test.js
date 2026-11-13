import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'backup-private-media.sh');

async function fixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-private-media-backup-'));
  const fakeBin = path.join(temporaryRoot, 'bin');
  const mediaRoot = path.join(temporaryRoot, 'private-media');
  const backupDir = path.join(temporaryRoot, 'backups');
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
  await chmod(tar, 0o700);
  await chmod(age, 0o700);
  return { temporaryRoot, fakeBin, mediaRoot, backupDir };
}

function run(env) {
  return spawnSync('bash', [script], { encoding: 'utf8', env });
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
      BACKUP_RETENTION_DAYS: '30'
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
    await rm(f.temporaryRoot, { recursive: true, force: true });
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
      BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient'
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

test('private media backup fails closed when encryption recipient is absent', async () => {
  const f = await fixture();
  try {
    const result = run({
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH || ''}`,
      PRIVATE_MEDIA_DIR: f.mediaRoot,
      BACKUP_DIR: f.backupDir,
      BACKUP_AGE_RECIPIENT: ''
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(f.backupDir).catch(() => []), []);
  } finally {
    await rm(f.temporaryRoot, { recursive: true, force: true });
  }
});
