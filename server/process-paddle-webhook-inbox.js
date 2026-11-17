import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { processPaddleEvent } from './paddleBilling.js';
import { processOnePaddleWebhook } from './paddleWebhookInbox.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required for the Paddle webhook inbox worker.');
  process.exit(1);
}
if (process.env.PADDLE_ENVIRONMENT !== 'sandbox') {
  console.error('Paddle webhook inbox worker is sandbox-only until a separately reviewed production design is approved.');
  process.exit(1);
}

export async function runPaddleWebhookInboxWorker({
  pool,
  shouldStop = () => false,
  idleMs = 1_000,
  onResult = result => {
    if (result.claimed) console.log('Paddle webhook inbox item handled:', {
      processed: result.processed === true,
      retryScheduled: result.retryScheduled === true,
      leaseLost: result.leaseLost === true,
      errorCode: result.errorCode
    });
  }
}) {
  while (!shouldStop()) {
    const result = await processOnePaddleWebhook(pool, processPaddleEvent);
    if (result.claimed) onResult(result);
    else await new Promise(resolve => setTimeout(resolve, idleMs));
  }
}

async function main() {
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
    await runPaddleWebhookInboxWorker({ pool, shouldStop: () => stopping });
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
