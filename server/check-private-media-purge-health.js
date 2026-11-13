import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const QUEUE_HEALTH_SQL = `
  SELECT 'private_photo' AS queue_name,
         count(*)::bigint AS pending,
         count(*) FILTER (WHERE next_attempt_at <= statement_timestamp())::bigint AS due,
         COALESCE(EXTRACT(EPOCH FROM (statement_timestamp() - min(created_at))), 0)::bigint AS oldest_age_seconds,
         COALESCE(max(attempts), 0)::bigint AS max_attempts
  FROM private_photo_purge_queue
  UNION ALL
  SELECT 'private_voice_intro' AS queue_name,
         count(*)::bigint AS pending,
         count(*) FILTER (WHERE next_attempt_at <= statement_timestamp())::bigint AS due,
         COALESCE(EXTRACT(EPOCH FROM (statement_timestamp() - min(created_at))), 0)::bigint AS oldest_age_seconds,
         COALESCE(max(attempts), 0)::bigint AS max_attempts
  FROM private_voice_intro_purge_queue
`;

function nonNegativeLimit(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function evaluatePrivateMediaPurgeHealth(rows, {
  maxPending,
  maxOldestAgeSeconds,
  maxAttempts
} = {}) {
  const limits = {
    maxPending: nonNegativeLimit(maxPending, 'maxPending'),
    maxOldestAgeSeconds: nonNegativeLimit(maxOldestAgeSeconds, 'maxOldestAgeSeconds'),
    maxAttempts: nonNegativeLimit(maxAttempts, 'maxAttempts')
  };
  const queues = (Array.isArray(rows) ? rows : []).map(row => ({
    queue: String(row.queue_name),
    pending: Number(row.pending || 0),
    due: Number(row.due || 0),
    oldestAgeSeconds: Number(row.oldest_age_seconds || 0),
    maxAttempts: Number(row.max_attempts || 0)
  }));
  const violations = [];
  for (const queue of queues) {
    if (limits.maxPending !== null && queue.pending > limits.maxPending) {
      violations.push({ queue: queue.queue, metric: 'pending', actual: queue.pending, limit: limits.maxPending });
    }
    if (limits.maxOldestAgeSeconds !== null && queue.oldestAgeSeconds > limits.maxOldestAgeSeconds) {
      violations.push({ queue: queue.queue, metric: 'oldestAgeSeconds', actual: queue.oldestAgeSeconds, limit: limits.maxOldestAgeSeconds });
    }
    if (limits.maxAttempts !== null && queue.maxAttempts > limits.maxAttempts) {
      violations.push({ queue: queue.queue, metric: 'maxAttempts', actual: queue.maxAttempts, limit: limits.maxAttempts });
    }
  }
  return { healthy: violations.length === 0, queues, violations, limits };
}

export async function runPrivateMediaPurgeHealth({
  databaseUrl = process.env.DATABASE_URL,
  pool: suppliedPool,
  maxPending = process.env.PRIVATE_MEDIA_PURGE_MAX_PENDING,
  maxOldestAgeSeconds = process.env.PRIVATE_MEDIA_PURGE_MAX_OLDEST_AGE_SECONDS,
  maxAttempts = process.env.PRIVATE_MEDIA_PURGE_MAX_ATTEMPTS
} = {}) {
  if (!databaseUrl && !suppliedPool) throw new Error('DATABASE_URL is required');
  const pool = suppliedPool || new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const result = await pool.query(QUEUE_HEALTH_SQL);
    return evaluatePrivateMediaPurgeHealth(result.rows, { maxPending, maxOldestAgeSeconds, maxAttempts });
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPrivateMediaPurgeHealth()
    .then(report => {
      console.log(JSON.stringify(report));
      if (!report.healthy) process.exitCode = 2;
    })
    .catch(error => {
      console.error('Private media purge health check failed:', error?.message || 'unknown error');
      process.exitCode = 1;
    });
}
