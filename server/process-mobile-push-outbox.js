import 'dotenv/config';
import pg from 'pg';
import { processMobilePushOutboxBatch } from './mobilePushOutbox.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  console.error('Mobile push worker requires DATABASE_URL.');
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const summary = await processMobilePushOutboxBatch(pool, {
      batchSize: Number.parseInt(process.env.MOBILE_PUSH_BATCH_SIZE || '100', 10)
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error('Mobile push outbox worker failed:', error?.message || 'unknown error');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
