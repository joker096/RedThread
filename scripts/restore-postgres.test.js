import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'restore-postgres.sh');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-postgres-restore-'));
  const bin = path.join(root, 'bin');
  const archive = path.join(root, 'backup.dump.age');
  const identity = path.join(root, 'identity.txt');
  const capture = path.join(root, 'restored.dump');
  await mkdir(bin);
  await writeFile(archive, 'AGE-ENCRYPTED-POSTGRES-FIXTURE');
  await writeFile(identity, 'AGE-SECRET-IDENTITY-FIXTURE');

  const age = path.join(bin, 'age');
  const psql = path.join(bin, 'psql');
  const pgRestore = path.join(bin, 'pg_restore');
  await writeFile(age, `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${FAIL_AGE:-0}" == "1" ]]; then exit 23; fi
printf 'RESTORED-PLAINTEXT-DUMP-FIXTURE'
`);
  await writeFile(psql, `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "\${PSQL_EMPTY_STATE:-0}"
`);
  await writeFile(pgRestore, `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${FAIL_PG_RESTORE:-0}" == "1" ]]; then cat >/dev/null; exit 24; fi
cat > "\${RESTORE_CAPTURE}"
printf '%s\\n' "$*" > "\${RESTORE_ARGS_CAPTURE}"
`);
  for (const file of [age, psql, pgRestore]) await chmod(file, 0o700);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\\n`);
  return { root, bin, archive, identity, capture, pgRestoreArgs: `${capture}.args` };
}

function run(f, overrides = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH || ''}`,
      ARCHIVE_FILE: f.archive,
      AGE_IDENTITY_FILE: f.identity,
      RESTORE_DATABASE_URL: 'postgresql://staging-user:secret@example.invalid/vow_restore_test',
      RESTORE_CONFIRM_STAGING: 'I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE',
      RESTORE_CAPTURE: f.capture,
      RESTORE_ARGS_CAPTURE: f.pgRestoreArgs,
      ...overrides
    }
  });
}

test('PostgreSQL restore verifies checksum, requires an empty staging DB and streams plaintext to pg_restore', async () => {
  const f = await fixture();
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(f.capture, 'utf8'), 'RESTORED-PLAINTEXT-DUMP-FIXTURE');
    const args = await readFile(f.pgRestoreArgs, 'utf8');
    assert.equal(args.trim().split(' ').at(-1), '-');
    assert.equal(args.trim().split(' ').at(-1), '-');
    assert.match(args, /--no-acl/);
    assert.match(args, /(^|\\s)-($|\\s)/);
    const files = await readdir(f.root, { recursive: true });
    assert.equal(files.some(name => name.endsWith('.tmp') || name.includes('plaintext')), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PostgreSQL restore refuses a non-empty target before decryption', async () => {
  const f = await fixture();
  try {
    const result = run(f, { PSQL_EMPTY_STATE: '2' });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(f.capture));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PostgreSQL restore rejects checksum mismatch before connecting or restoring', async () => {
  const f = await fixture();
  try {
    await writeFile(f.archive, 'tampered backup');
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum verification failed/);
    await assert.rejects(readFile(f.capture));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PostgreSQL restore cleans up a failed decryption stream without writing a dump file', async () => {
  const f = await fixture();
  try {
    const result = run(f, { FAIL_AGE: '1' });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(f.capture));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('PostgreSQL restore propagates pg_restore failure', async () => {
  const f = await fixture();
  try {
    const result = run(f, { FAIL_PG_RESTORE: '1' });
    assert.notEqual(result.status, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
