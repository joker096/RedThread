import pg from 'pg';
import { resolvePrivacyRecoveryMappings } from './privacyRecoveryMapping.js';
import { applyPrivateMediaPrivacyRecoveryEvent } from './privacyRecoveryMediaExecutor.js';

const { Pool } = pg;
const SUPPORTED_MEDIA_EVENTS = new Set([
  'private_photo_erasure_requested',
  'voice_intro_erasure_requested',
  'voice_intro_consent_withdrawn'
]);

function assertIsolatedRestore(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_executor_requires_isolated_restore');
  }
  if (typeof env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY !== 'string' ||
      env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY.length < 32) {
    throw new Error('privacy_recovery_executor_pseudonym_key_required');
  }
}

function validateWatermarks(snapshotLedgerSequence, throughSequence) {
  if (!Number.isSafeInteger(snapshotLedgerSequence) || snapshotLedgerSequence < 0 ||
      !Number.isSafeInteger(throughSequence) || throughSequence < snapshotLedgerSequence) {
    throw new TypeError('privacy_recovery_executor_watermark_invalid');
  }
}

/**
 * Replays only the first supported private-media event run in ledger order.
 * Events are individually atomic and resumable through immutable receipts.
 * The caller must keep all restored services/workers/webhooks/egress disabled.
 */
export async function runPrivateMediaPrivacyRecovery({
  pool,
  env = process.env,
  snapshotLedgerSequence,
  throughSequence,
  photoStorageRoot,
  voiceStorageRoot,
  applyEvent = applyPrivateMediaPrivacyRecoveryEvent
}) {
  assertIsolatedRestore(env);
  validateWatermarks(snapshotLedgerSequence, throughSequence);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('privacy_recovery_executor_pool_required');

  const client = await pool.connect();
  let transactionOpen = false;
  let events;
  let mappings;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const staged = await client.query(
      `SELECT ledger_sequence AS sequence, event_id, event_type, subject_ref, resource_ref
         FROM privacy_recovery_events
        WHERE ledger_sequence > $1 AND ledger_sequence <= $2
        ORDER BY ledger_sequence ASC`,
      [snapshotLedgerSequence, throughSequence]
    );
    events = staged.rows || [];
    const expectedCount = throughSequence - snapshotLedgerSequence;
    if (events.length !== expectedCount) throw new Error('privacy_recovery_executor_sequence_range_incomplete');
    for (let index = 0; index < events.length; index += 1) {
      if (Number(events[index].sequence) !== snapshotLedgerSequence + index + 1) {
        throw new Error('privacy_recovery_executor_sequence_gap');
      }
    }

    const [users, voiceIntros, photos] = await Promise.all([
      client.query('SELECT id FROM users'),
      client.query('SELECT id FROM profile_voice_intros'),
      client.query('SELECT id FROM photo_assets')
    ]);
    mappings = resolvePrivacyRecoveryMappings({
      events,
      pseudonymKey: env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY,
      users: users.rows || [],
      voiceIntros: voiceIntros.rows || [],
      photos: photos.rows || [],
      giftOrders: []
    });
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    client.release();
  }

  let processedCount = 0;
  let alreadyAppliedCount = 0;
  for (const mapping of mappings) {
    if (!SUPPORTED_MEDIA_EVENTS.has(mapping.eventType)) {
      return {
        complete: false,
        processedCount,
        alreadyAppliedCount,
        blockedSequence: Number(mapping.sequence),
        blockedEventType: mapping.eventType,
        throughSequence
      };
    }
    const result = await applyEvent({
      pool,
      mapping,
      pseudonymKey: env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY,
      photoStorageRoot,
      voiceStorageRoot
    });
    if (result.alreadyApplied) alreadyAppliedCount += 1;
    else processedCount += 1;
  }

  return {
    complete: true,
    processedCount,
    alreadyAppliedCount,
    blockedSequence: null,
    blockedEventType: null,
    throughSequence
  };
}

export async function runPrivateMediaPrivacyRecoveryFromEnvironment({
  env = process.env,
  pool: suppliedPool,
  snapshotLedgerSequence,
  throughSequence
} = {}) {
  assertIsolatedRestore(env);
  if (!env.DATABASE_URL) throw new Error('privacy_recovery_executor_database_url_required');
  const pool = suppliedPool || new Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    ssl: env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    return await runPrivateMediaPrivacyRecovery({
      pool,
      env,
      snapshotLedgerSequence,
      throughSequence,
      photoStorageRoot: env.PHOTO_STORAGE_DIR,
      voiceStorageRoot: env.VOICE_INTRO_STORAGE_DIR
    });
  } finally {
    if (!suppliedPool) await pool.end();
  }
}
