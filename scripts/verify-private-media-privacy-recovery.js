import pg from 'pg';
import { verifyPrivateMediaPrivacyRecovery } from '../server/privacyRecoveryMediaVerification.js';

const { Pool } = pg;

function parseWatermark(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`privacy_recovery_verifier_${name}_invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`privacy_recovery_verifier_${name}_invalid`);
  return parsed;
}

async function main() {
  const [snapshotArg, throughArg, ...extra] = process.argv.slice(2);
  if (!snapshotArg || !throughArg || extra.length) {
    throw new Error('usage: node scripts/verify-private-media-privacy-recovery.js <snapshot-ledger-sequence> <through-sequence>');
  }
  const snapshotLedgerSequence = parseWatermark(snapshotArg, 'snapshot_sequence');
  const throughSequence = parseWatermark(throughArg, 'through_sequence');
  if (throughSequence < snapshotLedgerSequence) {
    throw new Error('privacy_recovery_verifier_watermark_range_invalid');
  }
  if (process.env.NODE_ENV === 'production' ||
      process.env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_verifier_requires_isolated_restore');
  }
  if (!process.env.DATABASE_URL) throw new Error('privacy_recovery_verifier_database_url_required');

  const storageRoots = {
    private_photo: process.env.PHOTO_STORAGE_DIR,
    private_voice_intro: process.env.VOICE_INTRO_STORAGE_DIR,
    identity_l3_media: process.env.IDENTITY_L3_STORAGE_DIR
  };
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const result = await verifyPrivateMediaPrivacyRecovery({
      pool,
      env: process.env,
      snapshotLedgerSequence,
      throughSequence,
      storageRoots
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\\n`);
    if (result.complete !== true) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error.message || 'privacy_recovery_verification_failed'}\\n`);
  process.exitCode = 1;
});
