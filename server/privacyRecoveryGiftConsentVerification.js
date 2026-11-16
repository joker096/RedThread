import { createHash, createHmac } from 'node:crypto';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const EVENT_TYPE = 'gift_order_consent_withdrawn';
const OUTCOME = 'gift_order_consent_withdrawn';

function assertIsolated(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_gift_consent_verification_requires_isolated_restore');
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

async function assertNoRows(client, sql, params, code) {
  const result = await client.query(sql, params);
  if (result.rowCount) throw new Error(code);
}

export async function verifyGiftConsentWithdrawalPrivacyRecovery({
  pool, env = process.env, snapshotLedgerSequence, throughSequence
}) {
  assertIsolated(env);
  assertPrivacyRecoveryRestoreTargetConfig(env);
  const pseudonymKey = env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY;
  if (typeof pseudonymKey !== 'string' || pseudonymKey.length < 32) {
    throw new Error('privacy_recovery_gift_consent_verification_pseudonym_key_required');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('privacy_recovery_gift_consent_verification_pool_required');
  }
  if (!Number.isSafeInteger(snapshotLedgerSequence) || snapshotLedgerSequence < 0 ||
      !Number.isSafeInteger(throughSequence) || throughSequence < snapshotLedgerSequence) {
    throw new TypeError('privacy_recovery_gift_consent_verification_watermark_invalid');
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
      throw new Error('privacy_recovery_gift_consent_verification_range_incomplete');
    }

    for (const event of result.rows) {
      if (event.event_type !== event.receipt_event_type ||
          event.event_type !== event.effect_event_type ||
          event.outcome_code !== OUTCOME || event.event_digest !== digestEvent(event) ||
          !event.subject_user_id || !event.resource_id ||
          String(event.resource_id).toLowerCase() !== String(event.resource_ref).toLowerCase() ||
          Number(event.purge_count) !== 0) {
        throw new Error('privacy_recovery_gift_consent_verification_receipt_mismatch');
      }
      const subjectDigest = createHmac('sha256', pseudonymKey)
        .update(event.subject_user_id, 'utf8').digest('hex');
      const resourceDigest = createHmac('sha256', pseudonymKey)
        .update(event.resource_id, 'utf8').digest('hex');
      if (subjectDigest !== String(event.subject_ref).toLowerCase() ||
          resourceDigest !== String(event.resource_ref).toLowerCase()) {
        throw new Error('privacy_recovery_gift_consent_verification_mapping_mismatch');
      }

      const order = await client.query(
        `SELECT id, sender_id, recipient_id, status, payment_status,
                consent_withdrawn_at, address_vault_ref, address_verified_at,
                public_reference
           FROM gift_delivery_orders WHERE id = $1`,
        [event.resource_id]
      );
      if (order.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_verification_order_missing');
      const o = order.rows[0];
      if (o.recipient_id !== event.subject_user_id || o.status !== 'cancelled' ||
          !o.consent_withdrawn_at || o.address_vault_ref !== null ||
          o.address_verified_at !== null ||
          !['not_started', 'failed', 'voided'].includes(o.payment_status)) {
        throw new Error('privacy_recovery_gift_consent_verification_order_state_invalid');
      }

      const audit = await client.query(
        `SELECT 1 FROM gift_delivery_order_events
          WHERE order_id = $1 AND actor_user_id = $2
            AND actor_type = 'recipient' AND event_type = 'consent_withdrawn'
            AND from_status IN ('recipient_accepted', 'address_verified')
            AND to_status = 'cancelled'
          LIMIT 1`,
        [event.resource_id, event.subject_user_id]
      );
      if (!audit.rowCount) throw new Error('privacy_recovery_gift_consent_verification_audit_missing');

      await assertNoRows(client,
        'SELECT 1 FROM gift_address_vault_entries WHERE order_id = $1 LIMIT 1',
        [event.resource_id], 'privacy_recovery_gift_consent_verification_vault_remains');
      await assertNoRows(client,
        'SELECT 1 FROM gift_address_drafts WHERE order_id = $1 LIMIT 1',
        [event.resource_id], 'privacy_recovery_gift_consent_verification_draft_remains');
      await assertNoRows(client,
        `SELECT 1 FROM gift_address_draft_consent_events
          WHERE order_id = $1 AND recipient_user_id = $2 AND action = 'granted'
            AND NOT EXISTS (
              SELECT 1 FROM gift_address_draft_consent_events latest
               WHERE latest.order_id = $1 AND latest.recipient_user_id = $2
                 AND latest.id > gift_address_draft_consent_events.id
                 AND latest.action IN ('withdrawn', 'expired')
            )
          LIMIT 1`,
        [event.resource_id, event.subject_user_id],
        'privacy_recovery_gift_consent_verification_draft_consent_active');

      const sender = await client.query('SELECT status FROM users WHERE id = $1', [o.sender_id]);
      if (sender.rowCount && sender.rows[0].status !== 'deleted') {
        const notification = await client.query(
          `SELECT 1 FROM user_notifications
            WHERE user_id = $1 AND type = 'gift_request_update'
              AND dedupe_key = $2 LIMIT 1`,
          [o.sender_id, 'gift_request_update:' + o.public_reference + ':consent_withdrawn']
        );
        if (!notification.rowCount) {
          throw new Error('privacy_recovery_gift_consent_verification_notification_missing');
        }
      }
      await assertNoRows(client,
        `SELECT 1 FROM privacy_recovery_replay_purge_obligations
          WHERE ledger_sequence = $1 AND event_id = $2 LIMIT 1`,
        [event.ledger_sequence, event.event_id],
        'privacy_recovery_gift_consent_verification_unexpected_purge_obligation');
    }

    await client.query('COMMIT');
    open = false;
    return { complete: true, verifiedGiftConsentWithdrawalCount: result.rows.length, throughSequence };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
