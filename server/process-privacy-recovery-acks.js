import { assertPrivacyRecoveryAdmission } from './privacyRecoveryAdmissionGuard.js';
assertPrivacyRecoveryAdmission();
import pg from 'pg';
import { resumePendingPrivacyRecoveryLedgerAcks } from './privacyRecoveryAckResumer.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for privacy Ledger ACK reconciliation');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000
});

try {
  const result = await resumePendingPrivacyRecoveryLedgerAcks({
    pool,
    limit: Number.parseInt(process.env.PRIVACY_RECOVERY_ACK_BATCH_SIZE || '25', 10)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`privacy Ledger ACK reconciliation failed: ${error?.message || 'unknown_error'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
