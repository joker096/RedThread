import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateEncryptedArchive } from './verify-encrypted-backups.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const backupScript = path.join(root, 'backup-private-media.sh');
const restoreScript = path.join(root, 'restore-private-media.sh');

function available(command) {
  return spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} exited with ${result.status}`);
  return result;
}

test('private media backup and restore round-trip with real age encryption and tar', {
  skip: !available('age') || !available('age-keygen') || !available('tar')
    ? 'age, age-keygen and tar are required for the real encrypted media restore drill'
    : false,
  timeout: 60_000
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-private-media-real-restore-'));
  const source = path.join(temporaryRoot, 'private-media');
  const backupDir = path.join(temporaryRoot, 'encrypted-backups');
  const identityFile = path.join(temporaryRoot, 'age-identity.txt');
  const wrongIdentityFile = path.join(temporaryRoot, 'wrong-age-identity.txt');
  const destination = path.join(temporaryRoot, 'isolated-restore', 'private-media');
  const fixture = Buffer.from('synthetic-private-media-fixture-not-user-data');
  const nestedFixture = Buffer.from([0, 1, 2, 3, 254, 255]);

  try {
    await mkdir(path.join(source, 'nested'), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(destination), { mode: 0o700 });
    await writeFile(path.join(source, 'photo-fixture.bin'), fixture, { mode: 0o600 });
    await writeFile(path.join(source, 'nested', 'voice-fixture.bin'), nestedFixture, { mode: 0o600 });

    run('age-keygen', ['-o', identityFile]);
    await chmod(identityFile, 0o600);
    const identity = await readFile(identityFile, 'utf8');
    const recipient = identity.match(/^# public key: (age1[0-9a-z]+)$/m)?.[1];
    assert.ok(recipient, 'age-keygen must produce a valid public recipient');

    run('bash', [backupScript], {
      PRIVATE_MEDIA_DIR: source,
      BACKUP_DIR: backupDir,
      BACKUP_AGE_RECIPIENT: recipient,
      BACKUP_RETENTION_DAYS: '30'
    });

    const artifacts = await readdir(backupDir);
    const archiveName = artifacts.find(name => name.endsWith('.tar.age'));
    assert.ok(archiveName, 'encrypted private-media archive must exist');
    assert.ok(artifacts.includes(`${archiveName}.sha256`), 'checksum sidecar must exist');
    const archivePath = path.join(backupDir, archiveName);
    await validateEncryptedArchive(archivePath, identityFile, 'tar');
    run('age-keygen', ['-o', wrongIdentityFile]);
    await chmod(wrongIdentityFile, 0o600);
    await assert.rejects(validateEncryptedArchive(archivePath, wrongIdentityFile, 'tar'),
      /backup_archive_authentication_or_format_invalid/);
    const encryptedArchive = await readFile(archivePath);
    assert.ok(encryptedArchive.subarray(0, 64).toString('utf8').includes('age-encryption.org/v1'),
      'backup must be a real age-encrypted archive');
    assert.equal(encryptedArchive.includes(fixture), false,
      'encrypted archive must not expose the synthetic plaintext fixture');
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
    assert.equal((await stat(backupDir)).mode & 0o777, 0o700);

    run('bash', [restoreScript], {
      ARCHIVE_FILE: archivePath,
      AGE_IDENTITY_FILE: identityFile,
      RESTORE_DESTINATION: destination
    });

    assert.deepEqual(await readFile(path.join(destination, 'photo-fixture.bin')), fixture);
    assert.deepEqual(await readFile(path.join(destination, 'nested', 'voice-fixture.bin')), nestedFixture);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);

    const tamperedArchive = path.join(backupDir, 'tampered.tar.age');
    await writeFile(tamperedArchive, Buffer.concat([encryptedArchive, Buffer.from('tampered')]), { mode: 0o600 });
    const tamperedChecksum = spawnSync('sha256sum', [tamperedArchive], { encoding: 'utf8' });
    assert.equal(tamperedChecksum.status, 0, tamperedChecksum.stderr || tamperedChecksum.stdout);
    await writeFile(`${tamperedArchive}.sha256`, `${'0'.repeat(64)}  tampered.tar.age\\n`, { mode: 0o600 });
    const rejectedDestination = path.join(temporaryRoot, 'isolated-restore', 'tampered');
    const rejected = spawnSync('bash', [restoreScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ARCHIVE_FILE: tamperedArchive,
        AGE_IDENTITY_FILE: identityFile,
        RESTORE_DESTINATION: rejectedDestination
      }
    });
    assert.notEqual(rejected.status, 0, 'restore must reject a tampered archive');
    await assert.rejects(stat(rejectedDestination), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
