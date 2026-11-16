import pg from 'pg';
import { resolvePrivacyRecoveryMappings } from './privacyRecoveryMapping.js';
import { applyPrivateMediaPrivacyRecoveryEvent } from './privacyRecoveryMediaExecutor.js';
import { applyAccountErasurePrivacyRecoveryEvent, preflightAccountErasurePrivacyRecovery } from './privacyRecoveryAccountErasureExecutor.js';
import { applyAdConsentRevocationPrivacyRecoveryEvent, preflightAdConsentRevocationPrivacyRecovery } from './privacyRecoveryAdConsentExecutor.js';
import { applyGiftConsentWithdrawalPrivacyRecoveryEvent, preflightGiftConsentWithdrawalPrivacyRecovery } from './privacyRecoveryGiftConsentExecutor.js';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const { Pool } = pg;
const SUPPORTED_MEDIA_EVENTS = new Set([
  'account_erasure_requested',
  'ad_consent_revoked',
  'gift_order_consent_withdrawn',
  'private_photo_erasure_requested',
  'voice_intro_erasure_requested',
  'voice_intro_consent_withdrawn',
  'identity_l3_consent_withdrawn'
]);

function assertIsolatedRestore(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_executor_requires_isolated_restore');
  }
  assertPrivacyRecoveryRestoreTargetConfig(env);
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
  applyEvent,
  preflightAccountErasure = preflightAccountErasurePrivacyRecovery,
  preflightAdConsent = preflightAdConsentRevocationPrivacyRecovery,
  preflightGiftConsent = preflightGiftConsentWithdrawalPrivacyRecovery
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
    await assertPrivacyRecoveryRestoreTarget(client, env);
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

    const [users, voiceIntros, photos, giftOrders] = await Promise.all([
      client.query('SELECT id FROM users'),
      client.query('SELECT id, user_id FROM profile_voice_intros'),
      client.query('SELECT id, user_id FROM photo_assets'),
      client.query('SELECT id, recipient_id AS user_id FROM gift_delivery_orders')
    ]);
    mappings = resolvePrivacyRecoveryMappings({
      events,
      pseudonymKey: env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY,
      users: users.rows || [],
      voiceIntros: voiceIntros.rows || [],
      photos: photos.rows || [],
      giftOrders: giftOrders.rows || []
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

  // Validate the entire ordered range before the first write. A supported
  // media event followed by an unsupported domain event must not partially
  // replay the prefix of a batch whose full domain semantics are unavailable.
  const firstUnsupported = mappings.find(mapping => !SUPPORTED_MEDIA_EVENTS.has(mapping.eventType));
  if (firstUnsupported) {
    return {
      complete: false,
      processedCount: 0,
      alreadyAppliedCount: 0,
      blockedSequence: Number(firstUnsupported.sequence),
      blockedEventType: firstUnsupported.eventType,
      throughSequence
    };
  }

  // Account erasure has destructive preconditions outside the event's SQL
  // writes (Paddle cancellation evidence and L3 object availability). Check
  // every such event before applying any earlier event in the requested range.
  const accountErasureSequences = new Map();
  for (const mapping of mappings) {
    if (mapping.eventType === 'account_erasure_requested' && mapping.subjectUserId) {
      accountErasureSequences.set(mapping.subjectUserId, BigInt(mapping.sequence));
    }
  }
  for (const mapping of mappings) {
    const accountSequence = mapping.subjectUserId ? accountErasureSequences.get(mapping.subjectUserId) : null;
    if (accountSequence !== undefined && accountSequence !== null &&
        BigInt(mapping.sequence) > accountSequence && mapping.eventType !== 'account_erasure_requested') {
      return {
        complete: false,
        processedCount: 0,
        alreadyAppliedCount: 0,
        blockedSequence: Number(mapping.sequence),
        blockedEventType: mapping.eventType,
        throughSequence
      };
    }
  }

  for (const mapping of mappings) {
      const preflight = mapping.eventType === 'account_erasure_requested'
        ? preflightAccountErasure
        : mapping.eventType === 'ad_consent_revoked'
          ? preflightAdConsent
          : mapping.eventType === 'gift_order_consent_withdrawn'
            ? preflightGiftConsent : null;
      if (!preflight) continue;
      try {
        await preflight({
          pool,
          mapping,
          pseudonymKey: env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY,
          env
        });
      } catch (error) {
        const message = error?.message;
        if (typeof message === 'string' &&
            (message.startsWith('privacy_recovery_account_erasure_') ||
             message.startsWith('privacy_recovery_ad_consent_') ||
             message.startsWith('privacy_recovery_gift_consent_'))) {
          return {
            complete: false,
            processedCount: 0,
            alreadyAppliedCount: 0,
            blockedSequence: Number(mapping.sequence),
            blockedEventType: mapping.eventType,
            throughSequence
          };
        }
        throw error;
      }
    }
  }

  let processedCount = 0;
  let alreadyAppliedCount = 0;
  for (const mapping of mappings) {
    const executor = applyEvent || (mapping.eventType === 'account_erasure_requested'
      ? applyAccountErasurePrivacyRecoveryEvent
      : mapping.eventType === 'ad_consent_revoked'
        ? applyAdConsentRevocationPrivacyRecoveryEvent
        : mapping.eventType === 'gift_order_consent_withdrawn'
          ? applyGiftConsentWithdrawalPrivacyRecoveryEvent
          : applyPrivateMediaPrivacyRecoveryEvent);
    const result = await executor({
      pool,
      mapping,
      env,
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
