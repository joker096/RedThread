import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'backup-postgres.sh');

test('PostgreSQL backup streams plaintext only through age and writes a private encrypted artifact', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-postgres-backup-test-'));
  const fakeBin = path.join(temporaryRoot, 'bin');
  const backupDir = path.join(temporaryRoot, 'backups');
  await mkdir(fakeBin);
  try {
    const pgDump = path.join(fakeBin, 'pg_dump');
    const age = path.join(fakeBin, 'age');
    await writeFile(pgDump, `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'fixture-plaintext-database-dump'
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
temporary_input="${output}.input"
cat > "$temporary_input"
{ printf 'AGE-ENCRYPTED-FIXTURE:'; cat "$temporary_input"; } > "$output"
rm -f "$temporary_input"
`);
    await chmod(pgDump, 0o700);
    await chmod(age, 0o700);

    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        DATABASE_URL: 'postgresql://backup-user:secret@example.invalid/vow',
        BACKUP_AGE_RECIPIENT: 'age1fixturepublicrecipient',
        BACKUP_DIR: backupDir,
        BACKUP_RETENTION_DAYS: '30'
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const files = await readdir(backupDir);
    const backupName = files.find(name => name.endsWith('.dump.age'));
    assert.ok(backupName, 'encrypted backup artifact should be created');
    assert.ok(files.includes(`${backupName}.sha256`), 'encrypted artifact checksum should be written');
    assert.equal(files.some(name => name.endsWith('.tmp') || name.endsWith('.input')), false,
      'temporary plaintext/intermediate files must be removed');

    const backupPath = path.join(backupDir, backupName);
    const encrypted = await readFile(backupPath, 'utf8');
    assert.ok(encrypted.startsWith('AGE-ENCRYPTED-FIXTURE:'));
    assert.equal(encrypted.includes('fixture-plaintext-database-dump'), true,
      'the fake age fixture preserves its input to prove that pg_dump is piped through the encryptor');
    const metadata = await stat(backupPath);
    assert.equal(metadata.mode & 0o777, 0o600, 'encrypted backup must be owner-readable only');
    const directoryMetadata = await stat(backupDir);
    assert.equal(directoryMetadata.mode & 0o777, 0o700, 'backup directory must be owner-accessible only');

    const checksum = spawnSync('sha256sum', ['--check', path.join(backupDir, `${backupName}.sha256`)], {
      encoding: 'utf8'
    });
    assert.equal(checksum.status, 0, checksum.stderr || checksum.stdout);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('PostgreSQL backup refuses to create plaintext artifacts without an age recipient', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-postgres-backup-no-recipient-'));
  const fakeBin = path.join(temporaryRoot, 'bin');
  const backupDir = path.join(temporaryRoot, 'backups');
  await mkdir(fakeBin);
  try {
    const pgDump = path.join(fakeBin, 'pg_dump');
    const age = path.join(fakeBin, 'age');
    await writeFile(pgDump, '#!/usr/bin/env bash\nprintf plaintext');
    await writeFile(age, '#!/usr/bin/env bash\ncat');
    await chmod(pgDump, 0o700);
    await chmod(age, 0o700);
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        DATABASE_URL: 'postgresql://backup-user:secret@example.invalid/vow',
        BACKUP_AGE_RECIPIENT: '',
        BACKUP_DIR: backupDir
      }
    });
    assert.notEqual(result.status, 0, 'missing encryption recipient must fail closed');
    assert.deepEqual(await readdir(backupDir).catch(() => []), [],
      'no backup artifact may be created when encryption is not configured');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
