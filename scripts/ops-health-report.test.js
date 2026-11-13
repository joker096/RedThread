import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectOpsHealth,
  evaluateQueueHealth,
  inspectBackupDirectory,
  opsHealthExitCode
} from './ops-health-report.js';

test('queue health is healthy when there is no outstanding purge work', () => {
  const report = evaluateQueueHealth({
    queue_name: 'private_photo',
    pending: 0,
    due: 0,
    retrying: 0,
    failed: 0,
    oldest_created_at: null,
    max_attempts: 0
  });
  assert.equal(report.status, 'healthy');
  assert.deepEqual(report.reasons, []);
});

test('failed L3 purge jobs make the operations report critical', () => {
  const report = evaluateQueueHealth({
    queue_name: 'identity_l3_media',
    pending: 1,
    due: 0,
    retrying: 1,
    failed: 1,
    oldest_created_at: new Date(),
    max_attempts: 5
  });
  assert.equal(report.status, 'critical');
  assert.ok(report.reasons.includes('failed_jobs_present'));
});

test('oldest pending purge work crosses the configured critical threshold', () => {
  const now = new Date('2026-11-13T12:00:00.000Z');
  const report = evaluateQueueHealth({
    queue_name: 'private_voice_intro',
    pending: 1,
    due: 1,
    retrying: 0,
    failed: 0,
    oldest_created_at: new Date(now.getTime() - 25 * 60 * 60_000),
    max_attempts: 0
  }, { now });
  assert.equal(report.status, 'critical');
  assert.ok(report.reasons.includes('oldest_job_exceeds_critical_age'));
});

test('operations report treats unconfigured off-host backup locations as not configured, not as healthy backups', async () => {
  const pool = {
    async query() {
      return {
        rows: [
          { queue_name: 'private_photo', pending: 0, due: 0, retrying: 0, failed: 0, oldest_created_at: null, max_attempts: 0 },
          { queue_name: 'private_voice_intro', pending: 0, due: 0, retrying: 0, failed: 0, oldest_created_at: null, max_attempts: 0 },
          { queue_name: 'identity_l3_media', pending: 0, due: 0, retrying: 0, failed: 0, oldest_created_at: null, max_attempts: 0 }
        ]
      };
    }
  };
  const report = await collectOpsHealth({ pool, now: new Date('2026-11-13T12:00:00Z') });
  assert.equal(report.status, 'healthy');
  assert.equal(report.backups.postgres.status, 'not_configured');
  assert.equal(report.backups.privatePhoto.status, 'not_configured');
  assert.equal(report.backups.privateVoice.status, 'not_configured');
  assert.equal(opsHealthExitCode(report), 0);
});

test('backup health requires a matching checksum sidecar and checks archive age', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-ops-backup-'));
  try {
    const archiveName = 'vow-postgres-20261113T115500Z.dump.age';
    const archivePath = path.join(root, archiveName);
    const checksum = 'a'.repeat(64);
    const now = new Date('2026-11-13T12:00:00.000Z');
    await writeFile(archivePath, 'encrypted-fixture');
    await writeFile(archivePath + '.sha256', checksum + '  ' + archiveName + '\n');
    const healthy = await inspectBackupDirectory(root, {
      archivePattern: /^vow-postgres-.*\.dump\.age$/,
      now
    });
    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.checksum, 'present_and_well_formed');

    await rm(archivePath + '.sha256');
    const missingChecksum = await inspectBackupDirectory(root, {
      archivePattern: /^vow-postgres-.*\.dump\.age$/,
      now
    });
    assert.equal(missingChecksum.status, 'critical');
    assert.equal(missingChecksum.reason, 'latest_backup_checksum_missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configured backup directory with no encrypted artifacts is critical', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-ops-empty-backup-'));
  try {
    const report = await inspectBackupDirectory(root, {
      archivePattern: /^vow-private-media-.*\.tar\.age$/,
      now: new Date()
    });
    assert.equal(report.status, 'critical');
    assert.equal(report.reason, 'no_encrypted_backup_found');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale encrypted backup crosses the warning age threshold', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-ops-stale-backup-'));
  try {
    const archiveName = 'vow-private-media-20261110T000000Z.tar.age';
    const archivePath = path.join(root, archiveName);
    const now = new Date('2026-11-13T12:00:00.000Z');
    await writeFile(archivePath, 'encrypted-fixture');
    await writeFile(archivePath + '.sha256', 'b'.repeat(64) + '  ' + archiveName + '\n');
    const oldTime = new Date(now.getTime() - 30 * 60 * 60_000);
    await utimes(archivePath, oldTime, oldTime);
    const report = await inspectBackupDirectory(root, {
      archivePattern: /^vow-private-media-.*\.tar\.age$/,
      now
    });
    assert.equal(report.status, 'warning');
    assert.equal(report.reason, 'latest_backup_exceeds_warning_age');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operations report reads the three durable purge queues from PostgreSQL', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured' : false,
  timeout: 15_000
}, async () => {
  const report = await collectOpsHealth({
    databaseUrl: process.env.DATABASE_URL,
    postgresBackupDir: null,
    privatePhotoBackupDir: null,
    privateVoiceBackupDir: null
  });
  assert.equal(report.queues.length, 3);
  assert.deepEqual(report.queues.map(queue => queue.queue).sort(), [
    'identity_l3_media',
    'private_photo',
    'private_voice_intro'
  ]);
});
