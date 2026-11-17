import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { processPaddleEvent } from './paddleBilling.js';
import { processOnePaddleWebhook } from './paddleWebhookInbox.js';

const { Pool } = pg;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Aggregate-only queue health; never selects event IDs, payloads, or user data. */
export async function getPaddleWebhookInboxMetrics(pool) {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
       COUNT(*) FILTER (WHERE status = 'retry')::int AS retry_count,
       COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
       COUNT(*) FILTER (WHERE status = 'processing'
         AND lease_expires_at <= statement_timestamp())::int AS expired_lease_count,
       COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter_count,
       COUNT(*) FILTER (WHERE status IN ('pending', 'retry')
         AND next_attempt_at <= statement_timestamp())::int AS due_count,
       COALESCE(EXTRACT(EPOCH FROM (statement_timestamp() - MIN(received_at)
         FILTER (WHERE status IN ('pending', 'retry', 'processing')))), 0)::int AS oldest_unfinished_age_seconds
     FROM paddle_webhook_inbox`
  );
  const row = result.rows[0] || {};
  return {
    pendingCount: Number(row.pending_count || 0),
    retryCount: Number(row.retry_count || 0),
    processingCount: Number(row.processing_count || 0),
    expiredLeaseCount: Number(row.expired_lease_count || 0),
    deadLetterCount: Number(row.dead_letter_count || 0),
    dueCount: Number(row.due_count || 0),
    oldestUnfinishedAgeSeconds: Number(row.oldest_unfinished_age_seconds || 0)
  };
}

export function paddleWebhookInboxAlerts(metrics) {
  return [
    ...(metrics.deadLetterCount > 0 ? ['dead_letter_events_present'] : []),
    ...(metrics.expiredLeaseCount > 0 ? ['expired_worker_leases_present'] : []),
    ...(metrics.oldestUnfinishedAgeSeconds >= 300 ? ['oldest_event_over_5m'] : []),
    ...(metrics.dueCount >= 100 ? ['backlog_over_100_due_events'] : [])
  ];
}

/**
 * A transient database/claim failure must not strand the durable inbox until
 * the container is restarted. Event-level failures are already persisted and
 * retried by processOnePaddleWebhook; this loop handles infrastructure errors.
 */
export async function runPaddleWebhookInboxWorker({
  pool,
  shouldStop = () => false,
  idleMs = 1_000,
  errorPollMs = 5_000,
  metricsEveryMs = 60_000,
  readMetrics = getPaddleWebhookInboxMetrics,
  processOne = processOnePaddleWebhook,
  wait = sleep,
  onResult = result => {
    if (result.claimed) console.log('Paddle webhook inbox item handled:', {
      processed: result.processed === true,
      retryScheduled: result.retryScheduled === true,
      leaseLost: result.leaseLost === true,
      errorCode: result.errorCode
    });
  },
  onMetrics = metrics => {
    const alerts = paddleWebhookInboxAlerts(metrics);
    console.log('Paddle webhook inbox metrics:', { ...metrics, alerts });
    if (alerts.length) console.error('Paddle webhook inbox alert:', { alerts });
  },
  onError = error => console.error('Paddle webhook inbox poll failed:', {
    errorCode: /^[a-z0-9_]{1,64}$/.test(String(error?.code || ''))
      ? error.code : 'paddle_webhook_worker_poll_failed'
  })
}) {
  if (!pool?.connect) throw new TypeError('database_pool_required');
  if (typeof shouldStop !== 'function' || typeof processOne !== 'function' ||
      typeof wait !== 'function' || typeof onResult !== 'function' ||
      typeof onError !== 'function' || typeof readMetrics !== 'function' || typeof onMetrics !== 'function') {
    throw new TypeError('worker_callback_invalid');
  }
  if (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 60_000 ||
      !Number.isInteger(errorPollMs) || errorPollMs < 100 || errorPollMs > 300_000 ||
      !Number.isInteger(metricsEveryMs) || metricsEveryMs < 0 || metricsEveryMs > 3_600_000) {
    throw new RangeError('paddle_webhook_worker_poll_interval_invalid');
  }

  let processed = 0;
  let errors = 0;
  let nextMetricsAt = metricsEveryMs > 0 ? Date.now() : Infinity;
  while (!shouldStop()) {
    if (Date.now() >= nextMetricsAt && !shouldStop()) {
      nextMetricsAt = Date.now() + metricsEveryMs;
      try {
        const metrics = await readMetrics(pool);
        try { onMetrics(metrics); } catch { /* Metrics sinks must not stop queue consumption. */ }
      } catch (error) {
        try { onError(error); } catch { /* Logging hooks must not crash the worker loop. */ }
      }
    }
    try {
      const result = await processOne(pool, processPaddleEvent);
      if (result?.claimed) {
        if (result.processed === true) processed += 1;
        try { onResult(result); } catch { /* Observability must not stop queue consumption. */ }
      } else if (!shouldStop()) {
        await wait(idleMs);
      }
    } catch (error) {
      errors += 1;
      try { onError(error); } catch { /* Logging hooks must not crash the worker loop. */ }
      if (!shouldStop()) await wait(errorPollMs);
    }
  }
  return { stopped: true, processed, errors };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the Paddle webhook inbox worker.');
  if (process.env.PADDLE_ENVIRONMENT !== 'sandbox') {
    throw new Error('Paddle webhook inbox worker is sandbox-only until a separately reviewed production design is approved.');
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const result = await runPaddleWebhookInboxWorker({
      pool,
      shouldStop: () => stopping
    });
    console.log('Paddle webhook inbox worker stopped:', result);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Paddle webhook inbox worker failed:', error?.code || 'unknown_error');
    process.exitCode = 1;
  });
}
