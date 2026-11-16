import { createHash, createHmac } from 'node:crypto';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const EVENT_TYPE = 'ad_consent_revoked';
const OUTCOME = 'ad_consent_revoked_fail_closed';

function assertIsolated(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_ad_consent_verification_requires_isolated_restore');
  }
}

function digestEvent(row) {
  const canonical = [
    String(row.ledger_sequence), row.event_id, String(row.schema_version), row.event_type,
    String(row.subject_ref).toLowerCase(), row.resource_ref?.toLowerCase() ?? null,
    new Date(row.occurred_at).toISOString(), new Date(row.received_at).toISOString()
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function allOff(value) {
  return value && value.adsConsent === false &&
    value.dateOffersConsent === false &&
    value.weddingOffersConsent === false &&
    value.marriagePlanningOptIn === false &&
    value.categoryConsents && typeof value.categoryConsents === 'object' &&
    !Array.isArray(value.categoryConsents) &&
    Object.keys(value.categoryConsents).length === 0;
}

export async function verifyAdConsentRevocationPrivacyRecovery({
  pool, env = process.env, snapshotLedgerSequence, throughSequence
}) {
  assertIsolated(env);
  assertPrivacyRecoveryRestoreTargetConfig(env);
  const pseudonymKey = env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY;
  if (typeof pseudonymKey !== 'string' || pseudonymKey.length < 32) {
    throw new Error('privacy_recovery_ad_consent_verification_pseudonym_key_required');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('privacy_recovery_ad_consent_verification_pool_required');
  }
  if (!Number.isSafeInteger(snapshotLedgerSequence) || snapshotLedgerSequence < 0 ||
      !Number.isSafeInteger(throughSequence) || throughSequence < snapshotLedgerSequence) {
    throw new TypeError('privacy_recovery_ad_consent_verification_watermark_invalid');
  }

  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    open = true;
    await assertPrivacyRecoveryRestoreTarget(client, env);
    const result = await client.query(
      `SELECT e.ledger_sequence, e.event_id, e.schema_version, e.event_type,
              e.subject_ref, e.resource_ref, e.occurred_at, e.received_at,
              r.event_digest, r.event_type AS receipt_event_type, r.outcome_code,
              x.event_type AS effect_event_type, x.subject_user_id, x.resource_id,
              x.purge_count
         FROM privacy_recovery_events e
         LEFT JOIN privacy_recovery_replay_receipts r
           ON r.ledger_sequence = e.ledger_sequence AND r.event_id = e.event_id
         LEFT JOIN privacy_recovery_replay_effects x
           ON x.ledger_sequence = e.ledger_sequence AND x.event_id = e.event_id
        WHERE e.ledger_sequence > $1 AND e.ledger_sequence <= $2
          AND e.event_type = $3
        ORDER BY e.ledger_sequence ASC`,
      [snapshotLedgerSequence, throughSequence, EVENT_TYPE]
    );
    const count = await client.query(
      `SELECT COUNT(*)::int AS count FROM privacy_recovery_events
        WHERE ledger_sequence > $1 AND ledger_sequence <= $2 AND event_type = $3`,
      [snapshotLedgerSequence, throughSequence, EVENT_TYPE]
    );
    if (result.rows.length !== count.rows[0].count) {
      throw new Error('privacy_recovery_ad_consent_verification_range_incomplete');
    }

    for (const row of result.rows) {
      if (row.event_type !== row.receipt_event_type || row.event_type !== row.effect_event_type ||
          row.outcome_code !== OUTCOME || row.event_digest !== digestEvent(row) ||
          row.resource_ref !== null || row.resource_id !== null ||
          !row.subject_user_id || Number(row.purge_count) !== 0) {
        throw new Error('privacy_recovery_ad_consent_verification_receipt_mismatch');
      }
      const expectedSubject = createHmac('sha256', pseudonymKey)
        .update(row.subject_user_id, 'utf8').digest('hex');
      if (expectedSubject !== String(row.subject_ref).toLowerCase()) {
        throw new Error('privacy_recovery_ad_consent_verification_subject_mismatch');
      }
      const laterAccountErasure = await client.query(
        `SELECT 1 FROM privacy_recovery_replay_effects
          WHERE event_type = 'account_erasure_requested'
            AND subject_user_id = $1 AND ledger_sequence > $2
          LIMIT 1`,
        [row.subject_user_id, row.ledger_sequence]
      );
      if (laterAccountErasure.rowCount) continue;

      const user = await client.query('SELECT status FROM users WHERE id = $1', [row.subject_user_id]);
      if (user.rowCount !== 1 || user.rows[0].status !== 'active') {
        throw new Error('privacy_recovery_ad_consent_verification_subject_state_invalid');
      }
      const preferences = await client.query(
        `SELECT ads_consent, date_offers_consent, wedding_offers_consent,
                marriage_planning_opt_in, category_consents, consent_version
           FROM ad_consent_preferences WHERE user_id = $1`,
        [row.subject_user_id]
      );
      if (preferences.rowCount !== 1) {
        throw new Error('privacy_recovery_ad_consent_verification_preferences_missing');
      }
      const p = preferences.rows[0];
      if (p.ads_consent !== false || p.date_offers_consent !== false ||
          p.wedding_offers_consent !== false || p.marriage_planning_opt_in !== false ||
          !p.category_consents || Object.keys(p.category_consents).length !== 0 ||
          p.consent_version !== 1) {
        throw new Error('privacy_recovery_ad_consent_verification_preferences_not_revoked');
      }
      const history = await client.query(
        `SELECT preferences, consent_version FROM ad_consent_history
          WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [row.subject_user_id]
      );
      if (history.rowCount !== 1 || history.rows[0].consent_version !== 1 ||
          !allOff(history.rows[0].preferences)) {
        throw new Error('privacy_recovery_ad_consent_verification_history_not_revoked');
      }
      const obligations = await client.query(
        `SELECT 1 FROM privacy_recovery_replay_purge_obligations
          WHERE ledger_sequence = $1 AND event_id = $2 LIMIT 1`,
        [row.ledger_sequence, row.event_id]
      );
      if (obligations.rowCount) {
        throw new Error('privacy_recovery_ad_consent_verification_unexpected_purge_obligation');
      }
    }

    await client.query('COMMIT');
    open = false;
    return { complete: true, verifiedAdConsentRevocationCount: result.rows.length, throughSequence };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
