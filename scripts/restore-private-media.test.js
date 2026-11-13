import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./restore-private-media.sh', import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-private-media-restore-'));
  const bin = path.join(root, 'bin');
  const source = path.join(root, 'source');
  const backup = path.join(root, 'media.tar.age');
  const identity = path.join(root, 'identity.txt');
  const destination = path.join(root, 'restored');
  await mkdir(bin);
  await mkdir(source);
  await writeFile(path.join(source, 'photo-fixture.txt'), 'private-photo-fixture');
  await writeFile(identity, 'AGE-SECRET-IDENTITY-FIXTURE');
  const age = path.join(bin, 'age');
  await writeFile(age, `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${FAIL_AGE:-0}" == "1" ]]; then exit 23; fi
archive="${!#}"
cat -- "$archive"
`);
  await chmod(age, 0o700);
  const packed = spawnSync('tar', ['--create', '--file', backup, '--directory', source, '.']);
  assert.equal(packed.status, 0);
  await writeFile(`${backup}.sha256`, `${(await import('node:crypto')).createHash('sha256').update(await readFile(backup)).digest('hex')}  ${path.basename(backup)}\n`);
  return { root, bin, backup, identity, destination };
}

function run(f, overrides = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH || ''}`,
      ARCHIVE_FILE: f.backup,
      AGE_IDENTITY_FILE: f.identity,
      RESTORE_DESTINATION: f.destination,
      ...overrides
    }
  });
}

test('private media restore verifies checksum and extracts into a new private staging directory', async () => {
  const f = await fixture();
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(path.join(f.destination, 'photo-fixture.txt'), 'utf8'), 'private-photo-fixture');
    assert.equal((await lstat(f.destination)).mode & 0o777, 0o700);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore refuses an existing destination without changing it', async () => {
  const f = await fixture();
  try {
    await mkdir(f.destination);
    await writeFile(path.join(f.destination, 'keep.txt'), 'keep');
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(f.destination, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore refuses a symlink destination', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, 'target');
    await mkdir(target);
    await symlink(target, f.destination);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.equal((await lstat(f.destination)).isSymbolicLink(), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore rejects a checksum mismatch before creating destination', async () => {
  const f = await fixture();
  try {
    await writeFile(f.backup, 'tampered archive');
    const result = run(f);
    assert.notEqual(result.status, 0);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore removes partial staging output after decryption failure', async () => {
  const f = await fixture();
  try {
    const result = run(f, { FAIL_AGE: '1' });
    assert.notEqual(result.status, 0);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
