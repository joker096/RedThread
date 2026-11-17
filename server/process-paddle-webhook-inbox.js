import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { processPaddleEvent } from './paddleBilling.js';
import { processOnePaddleWebhook } from './paddleWebhookInbox.js';

const { Pool } = pg;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
  onError = error => console.error('Paddle webhook inbox poll failed:', {
    errorCode: /^[a-z0-9_]{1,64}$/.test(String(error?.code || ''))
      ? error.code : 'paddle_webhook_worker_poll_failed'
  })
}) {
  if (!pool?.connect) throw new TypeError('database_pool_required');
  if (typeof shouldStop !== 'function' || typeof processOne !== 'function' ||
      typeof wait !== 'function' || typeof onResult !== 'function' ||
      typeof onError !== 'function') {
    throw new TypeError('worker_callback_invalid');
  }
  if (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 60_000 ||
      !Number.isInteger(errorPollMs) || errorPollMs < 100 || errorPollMs > 300_000) {
    throw new RangeError('paddle_webhook_worker_poll_interval_invalid');
  }

  let processed = 0;
  let errors = 0;
  while (!shouldStop()) {
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
