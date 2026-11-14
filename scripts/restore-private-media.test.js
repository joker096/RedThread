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
archive="\${!#}"
if [[ "\${FAIL_AGE:-0}" == "1" ]]; then exit 23; fi
if [[ "\${PARTIAL_AGE:-0}" == "1" ]]; then
  head -c 1 -- "$archive"
  exit 23
fi
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

test('private media restore removes staging output when decryption fails before producing data', async () => {
  const f = await fixture();
  try {
    const result = run(f, { FAIL_AGE: '1' });
    assert.notEqual(result.status, 0);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore removes partial staging output when the decrypt stream is interrupted', async () => {
  const f = await fixture();
  try {
    const result = run(f, { PARTIAL_AGE: '1' });
    assert.notEqual(result.status, 0);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


async function replaceArchive(f, source) {
  const packed = spawnSync('tar', ['--create', '--file', f.backup, '--directory', source, '.']);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(await readFile(f.backup)).digest('hex');
  await writeFile(`${f.backup}.sha256`, `${digest}  ${path.basename(f.backup)}\\n`);
}

test('private media restore rejects symlink members before extracting anything', async () => {
  const f = await fixture();
  const malicious = path.join(f.root, 'malicious');
  try {
    await mkdir(malicious);
    await writeFile(path.join(f.root, 'outside-secret.txt'), 'must-not-be-exposed');
    await symlink(path.join(f.root, 'outside-secret.txt'), path.join(malicious, 'external-link'));
    await replaceArchive(f, malicious);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /link or special filesystem entry/);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.root, 'outside-secret.txt'), 'utf8'), 'must-not-be-exposed');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore rejects hardlink members before extracting anything', async () => {
  const f = await fixture();
  const malicious = path.join(f.root, 'malicious-hardlink');
  try {
    await mkdir(malicious);
    await writeFile(path.join(malicious, 'original.txt'), 'private');
    await import('node:fs/promises').then(({ link }) => link(
      path.join(malicious, 'original.txt'),
      path.join(malicious, 'linked.txt')
    ));
    await replaceArchive(f, malicious);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /link or special filesystem entry/);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('private media restore rejects parent-directory traversal in archive member names', async () => {
  const f = await fixture();
  try {
    const malicious = spawnSync('tar', [
      '--create', '--file', f.backup, '--directory', path.join(f.root, 'source'),
      '--transform=s,^photo-fixture.txt,../escaped.txt,', 'photo-fixture.txt'
    ], { encoding: 'utf8' });
    assert.equal(malicious.status, 0, malicious.stderr || '');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(await readFile(f.backup)).digest('hex');
    await writeFile(`${f.backup}.sha256`, `${digest}  ${path.basename(f.backup)}\\n`);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parent traversal|escapes staging/);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(f.root, 'escaped.txt')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
