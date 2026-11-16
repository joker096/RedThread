import 'dotenv/config';
import pg from 'pg';
import { processPrivacyRecoveryOutboxBatch } from './privacyRecoveryOutbox.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
});
try {
  const result = await processPrivacyRecoveryOutboxBatch({ pool });
  console.log(JSON.stringify({
    claimed: result.claimed,
    acknowledged: result.results.filter(item => item.acknowledged).length,
    failed: result.results.filter(item => !item.acknowledged).length
  }));
  if (result.results.some(item => !item.acknowledged)) process.exitCode = 1;
} catch (error) {
  console.error('Privacy recovery outbox worker failed:', error?.message || 'unknown error');
  process.exitCode = 1;
} finally {
  await pool.end();
}
