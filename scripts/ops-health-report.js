import 'dotenv/config';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export const OPS_HEALTH_DEFAULTS = Object.freeze({
  queueWarnPending: 100,
  queueWarnOldestMinutes: 60,
  queueCriticalOldestMinutes: 1440,
  backupWarnAgeHours: 26,
  backupCriticalAgeHours: 48
});

const QUEUE_SQL = [
  "SELECT 'private_photo' AS queue_name,",
  "       COUNT(*)::int AS pending,",
  "       COUNT(*) FILTER (WHERE next_attempt_at <= statement_timestamp())::int AS due,",
  "       COUNT(*) FILTER (WHERE attempts > 0)::int AS retrying,",
  "       0::int AS failed, MIN(created_at) AS oldest_created_at,",
  "       COALESCE(MAX(attempts), 0)::int AS max_attempts",
  "FROM private_photo_purge_queue",
  "UNION ALL",
  "SELECT 'private_voice_intro', COUNT(*)::int,",
  "       COUNT(*) FILTER (WHERE next_attempt_at <= statement_timestamp())::int,",
  "       COUNT(*) FILTER (WHERE attempts > 0)::int, 0::int,",
  "       MIN(created_at), COALESCE(MAX(attempts), 0)::int",
  "FROM private_voice_intro_purge_queue",
  "UNION ALL",
  "SELECT 'identity_l3_media',",
  "       COUNT(*) FILTER (WHERE status IN ('queued', 'processing', 'failed'))::int,",
  "       COUNT(*) FILTER (WHERE status IN ('queued', 'processing') AND next_attempt_at <= statement_timestamp())::int,",
  "       COUNT(*) FILTER (WHERE attempts > 0 AND status IN ('queued', 'processing', 'failed'))::int,",
  "       COUNT(*) FILTER (WHERE status = 'failed')::int,",
  "       MIN(created_at) FILTER (WHERE status IN ('queued', 'processing', 'failed')),",
  "       COALESCE(MAX(attempts) FILTER (WHERE status IN ('queued', 'processing', 'failed')), 0)::int",
  "FROM identity_l3_media_purge_jobs"
].join('\n');

function statusRank(status) {
  return status === 'critical' ? 2 : status === 'warning' ? 1 : 0;
}

function combineStatus(statuses) {
  return statuses.reduce((worst, current) =>
    statusRank(current) > statusRank(worst) ? current : worst, 'healthy');
}

export function evaluateQueueHealth(row, { now = new Date(), thresholds = OPS_HEALTH_DEFAULTS } = {}) {
  const pending = Number(row.pending || 0);
  const due = Number(row.due || 0);
  const retrying = Number(row.retrying || 0);
  const failed = Number(row.failed || 0);
  const oldestCreatedAt = row.oldest_created_at ? new Date(row.oldest_created_at) : null;
  const oldestMinutes = oldestCreatedAt && Number.isFinite(oldestCreatedAt.getTime())
    ? Math.max(0, (now.getTime() - oldestCreatedAt.getTime()) / 60_000)
    : null;
  let status = 'healthy';
  const reasons = [];

  if (failed > 0) {
    status = 'critical';
    reasons.push('failed_jobs_present');
  }
  if (oldestMinutes !== null && oldestMinutes >= thresholds.queueCriticalOldestMinutes) {
    status = 'critical';
    reasons.push('oldest_job_exceeds_critical_age');
  } else if (oldestMinutes !== null && oldestMinutes >= thresholds.queueWarnOldestMinutes) {
    status = combineStatus([status, 'warning']);
    reasons.push('oldest_job_exceeds_warning_age');
  }
  if (pending > thresholds.queueWarnPending) {
    status = combineStatus([status, 'warning']);
    reasons.push('pending_count_exceeds_warning_threshold');
  }
  if (retrying > 0) {
    status = combineStatus([status, 'warning']);
    reasons.push('retry_attempts_present');
  }

  return {
    queue: row.queue_name,
    status,
    pending,
    due,
    retrying,
    failed,
    oldestCreatedAt: oldestCreatedAt && Number.isFinite(oldestCreatedAt.getTime())
      ? oldestCreatedAt.toISOString() : null,
    oldestMinutes: oldestMinutes === null ? null : Math.round(oldestMinutes),
    maxAttempts: Number(row.max_attempts || 0),
    reasons
  };
}

export async function inspectBackupDirectory(directory, {
  archivePattern,
  now = new Date(),
  thresholds = OPS_HEALTH_DEFAULTS
} = {}) {
  if (!directory) return { status: 'not_configured', directory: null, latest: null, ageHours: null, reason: null };

  const resolvedDirectory = path.resolve(directory);
  let rootInfo;
  try {
    rootInfo = await lstat(resolvedDirectory);
  } catch (error) {
    return { status: 'critical', directory: resolvedDirectory, latest: null, ageHours: null, reason: error?.code === 'ENOENT' ? 'backup_directory_missing' : 'backup_directory_unreadable' };
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { status: 'critical', directory: resolvedDirectory, latest: null, ageHours: null, reason: 'backup_directory_not_a_real_directory' };
  }

  const names = await readdir(resolvedDirectory);
  const archives = [];
  for (const name of names) {
    if (!archivePattern.test(name)) continue;
    const filePath = path.join(resolvedDirectory, name);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { status: 'critical', directory: resolvedDirectory, latest: name, ageHours: null, reason: 'backup_archive_not_a_regular_file' };
    }
    archives.push({ name, filePath, mtimeMs: info.mtimeMs });
  }

  if (archives.length === 0) {
    return { status: 'critical', directory: resolvedDirectory, latest: null, ageHours: null, reason: 'no_encrypted_backup_found' };
  }
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = archives[0];
  const checksumPath = latest.filePath + '.sha256';
  let checksumInfo;
  try {
    checksumInfo = await lstat(checksumPath);
  } catch {
    return { status: 'critical', directory: resolvedDirectory, latest: latest.name, ageHours: null, reason: 'latest_backup_checksum_missing' };
  }
  if (checksumInfo.isSymbolicLink() || !checksumInfo.isFile()) {
    return { status: 'critical', directory: resolvedDirectory, latest: latest.name, ageHours: null, reason: 'latest_backup_checksum_not_a_regular_file' };
  }
  const checksumText = await readFile(checksumPath, 'utf8');
  const digest = checksumText.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(digest || '')) {
    return { status: 'critical', directory: resolvedDirectory, latest: latest.name, ageHours: null, reason: 'latest_backup_checksum_malformed' };
  }

  const ageHours = Math.max(0, (now.getTime() - latest.mtimeMs) / 3_600_000);
  let status = 'healthy';
  let reason = null;
  if (ageHours >= thresholds.backupCriticalAgeHours) {
    status = 'critical';
    reason = 'latest_backup_exceeds_critical_age';
  } else if (ageHours >= thresholds.backupWarnAgeHours) {
    status = 'warning';
    reason = 'latest_backup_exceeds_warning_age';
  }

  return {
    status,
    directory: resolvedDirectory,
    latest: latest.name,
    ageHours: Math.round(ageHours * 10) / 10,
    checksum: 'present_and_well_formed',
    reason
  };
}

export async function collectOpsHealth({
  databaseUrl = process.env.DATABASE_URL,
  pool: suppliedPool,
  now = new Date(),
  thresholds = OPS_HEALTH_DEFAULTS,
  postgresBackupDir = process.env.OPS_POSTGRES_BACKUP_DIR,
  privatePhotoBackupDir = process.env.OPS_PRIVATE_PHOTO_BACKUP_DIR,
  privateVoiceBackupDir = process.env.OPS_PRIVATE_VOICE_BACKUP_DIR
} = {}) {
  if (!databaseUrl && !suppliedPool) throw new Error('DATABASE_URL is required');
  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });

  try {
    const [queueResult, postgresBackup, privatePhotoBackup, privateVoiceBackup] = await Promise.all([
      pool.query(QUEUE_SQL),
      inspectBackupDirectory(postgresBackupDir, { archivePattern: /^vow-postgres-.*\.dump\.age$/, now, thresholds }),
      inspectBackupDirectory(privatePhotoBackupDir, { archivePattern: /^vow-private-media-.*\.tar\.age$/, now, thresholds }),
      inspectBackupDirectory(privateVoiceBackupDir, { archivePattern: /^vow-private-media-.*\.tar\.age$/, now, thresholds })
    ]);
    const queues = queueResult.rows.map(row => evaluateQueueHealth(row, { now, thresholds }));
    const backups = {
      postgres: postgresBackup,
      privatePhoto: privatePhotoBackup,
      privateVoice: privateVoiceBackup
    };
    const status = combineStatus([
      ...queues.map(queue => queue.status),
      ...Object.values(backups).filter(backup => backup.status !== 'not_configured').map(backup => backup.status)
    ]);
    return {
      generatedAt: now.toISOString(),
      status,
      queues,
      backups
    };
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

export function opsHealthExitCode(report) {
  return report?.status === 'critical' ? 2 : report?.status === 'warning' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectOpsHealth()
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = opsHealthExitCode(report);
    })
    .catch(error => {
      console.error('Vow operations health report failed:', error?.message || 'unknown error');
      process.exitCode = 2;
    });
}
