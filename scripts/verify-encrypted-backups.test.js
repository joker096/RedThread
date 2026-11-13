import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  verifyEncryptedBackupDirectory,
  verifyConfiguredEncryptedBackups
} from './verify-encrypted-backups.js';

async function addBackup(root, name, bytes) {
  const archive = path.join(root, name);
  await writeFile(archive, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(archive + '.sha256', digest + '  ' + name + '\n');
  return archive;
}

test('verifies actual encrypted backup bytes against a matching sidecar', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-verify-'));
  try {
    await addBackup(root, 'vow-postgres-20261113T120000Z.dump.age', 'encrypted-fixture');
    const result = await verifyEncryptedBackupDirectory(root, {
      name: 'postgres',
      pattern: /^vow-postgres-.*\.dump\.age$/
    });
    assert.deepEqual(result, { name: 'postgres', status: 'verified', checked: 1, failures: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects a backup changed after its checksum was written', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-corrupt-'));
  try {
    const archive = await addBackup(root, 'vow-private-media-20261113T120000Z.tar.age', 'original');
    await writeFile(archive, 'tampered');
    const result = await verifyEncryptedBackupDirectory(root, {
      name: 'privatePhoto',
      pattern: /^vow-private-media-.*\.tar\.age$/
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.includes('backup_checksum_mismatch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed sidecars and sidecars naming a different archive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-sidecar-'));
  try {
    const archive = await addBackup(root, 'vow-postgres-20261113T120000Z.dump.age', 'fixture');
    await writeFile(archive + '.sha256', 'a'.repeat(64) + '  other.dump.age\n');
    const result = await verifyEncryptedBackupDirectory(root, {
      name: 'postgres',
      pattern: /^vow-postgres-.*\.dump\.age$/
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.includes('backup_checksum_malformed_or_filename_mismatch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinked backup artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-symlink-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-outside-'));
  try {
    const target = await addBackup(outside, 'vow-postgres-20261113T120000Z.dump.age', 'fixture');
    await symlink(target, path.join(root, path.basename(target)));
    await writeFile(path.join(root, path.basename(target) + '.sha256'), 'a'.repeat(64) + '  ' + path.basename(target) + '\n');
    const result = await verifyEncryptedBackupDirectory(root, {
      name: 'postgres',
      pattern: /^vow-postgres-.*\.dump\.age$/
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.includes('backup_archive_not_a_regular_file'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('reports missing configuration separately from verified backups', async () => {
  const report = await verifyConfiguredEncryptedBackups({});
  assert.equal(report.status, 'not_configured');
  assert.ok(report.results.every(result => result.status === 'not_configured'));
});

test('partial backup configuration is not reported as fully verified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-partial-'));
  try {
    const archive = 'vow-postgres-20261113T120000Z.dump.age';
    await addBackup(root, archive, 'encrypted-fixture');
    const report = await verifyConfiguredEncryptedBackups({
      OPS_POSTGRES_BACKUP_DIR: root
    });
    assert.equal(report.status, 'partially_configured');
    assert.deepEqual(report.results.map(result => result.status), [
      'verified', 'not_configured', 'not_configured'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configured empty backup directory fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-empty-'));
  try {
    const result = await verifyEncryptedBackupDirectory(root, {
      name: 'postgres',
      pattern: /^vow-postgres-.*\.dump\.age$/
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.includes('no_encrypted_backup_found'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
