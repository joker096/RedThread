import { assertPrivacyRecoveryAdmission } from './privacyRecoveryAdmissionGuard.js';
assertPrivacyRecoveryAdmission();
import 'dotenv/config';
import pg from 'pg';
import { purgeExpiredGiftAddressDrafts } from './giftAddressDraftPurge.js';

const { Pool } = pg;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const result = await purgeExpiredGiftAddressDrafts(pool, {
      batchSize: process.env.GIFT_ADDRESS_DRAFT_PURGE_BATCH_SIZE || 100
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write('gift address draft purge failed: ' + (error?.message || 'unknown error') + '\n');
  process.exitCode = 1;
});
