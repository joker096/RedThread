import { createHash } from 'node:crypto';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const EVENT_TYPE = 'account_erasure_requested';
const OUTCOME = 'account_erasure_replayed';

function assertIsolated(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_account_erasure_verification_requires_isolated_restore');
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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function assertNoRows(client, sql, params, code) {
  const result = await client.query(sql, params);
  if (result.rowCount) throw new Error(code);
}

export async function verifyAccountErasurePrivacyRecovery({
  pool, env = process.env, snapshotLedgerSequence, throughSequence
}) {
  assertIsolated(env);
  assertPrivacyRecoveryRestoreTargetConfig(env);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('privacy_recovery_account_erasure_verification_pool_required');
  if (!Number.isSafeInteger(snapshotLedgerSequence) || snapshotLedgerSequence < 0 ||
      !Number.isSafeInteger(throughSequence) || throughSequence < snapshotLedgerSequence) {
    throw new TypeError('privacy_recovery_account_erasure_verification_watermark_invalid');
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
              x.purge_count, x.account_reuse_hmac
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
    const events = result.rows || [];
    const stagedCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM privacy_recovery_events
        WHERE ledger_sequence > $1 AND ledger_sequence <= $2 AND event_type = $3`,
      [snapshotLedgerSequence, throughSequence, EVENT_TYPE]
    );
    if (events.length !== stagedCount.rows[0].count) {
      throw new Error('privacy_recovery_account_erasure_verification_range_incomplete');
    }

    const verified = [];
    for (const row of events) {
      if (!row.event_digest || row.event_type !== row.receipt_event_type ||
          row.event_type !== row.effect_event_type || row.outcome_code !== OUTCOME ||
          row.event_digest !== digestEvent(row) || !row.subject_user_id ||
          row.resource_id !== null || !/^[a-f0-9]{64}$/i.test(row.account_reuse_hmac || '') ||
          !Number.isSafeInteger(Number(row.purge_count)) || Number(row.purge_count) < 0) {
        throw new Error('privacy_recovery_account_erasure_verification_receipt_mismatch');
      }
      verified.push(row);
    }

    for (const event of verified) {
      const userId = event.subject_user_id;
      const user = await client.query(
        `SELECT status, email, password_hash, email_verified_at, phone_e164,
                phone_verified_at, female_trial_ends_at, premium_until, premium_lifetime,
                paddle_subscription_id, paddle_subscription_status
           FROM users WHERE id = $1`,
        [userId]
      );
      if (user.rowCount !== 1 || user.rows[0].status !== 'deleted' ||
          user.rows[0].email !== 'deleted+' + userId + '@deleted.invalid' ||
          user.rows[0].password_hash !== null || user.rows[0].email_verified_at !== null ||
          user.rows[0].phone_e164 !== null || user.rows[0].phone_verified_at !== null ||
          user.rows[0].female_trial_ends_at !== null || user.rows[0].premium_until !== null ||
          user.rows[0].premium_lifetime !== false ||
          (user.rows[0].paddle_subscription_id &&
            !['canceled', 'completed'].includes(String(user.rows[0].paddle_subscription_status || '').toLowerCase()))) {
        throw new Error('privacy_recovery_account_erasure_verification_user_state_invalid');
      }

      const profile = await client.query(
        `SELECT display_name, birth_date, gender, country, city, bio, photo_urls,
                occupation, education, languages, is_visible, has_children,
                children_disclosure_confirmed_at
           FROM profiles WHERE user_id = $1`,
        [userId]
      );
      if (profile.rowCount !== 1) throw new Error('privacy_recovery_account_erasure_verification_profile_missing');
      const p = profile.rows[0];
      if (p.display_name !== 'Удалённый пользователь' || p.birth_date !== null ||
          p.gender !== null || p.country !== '—' || p.city !== '—' || p.bio !== '' ||
          (p.photo_urls || []).length !== 0 || p.occupation !== '' || p.education !== '' ||
          (p.languages || []).length !== 0 || p.is_visible !== false ||
          p.has_children !== null || p.children_disclosure_confirmed_at !== null) {
        throw new Error('privacy_recovery_account_erasure_verification_profile_not_scrubbed');
      }

      const scopedChecks = [
        ['sessions', 'user_id', 'privacy_recovery_account_erasure_verification_sessions_remain'],
        ['relationship_assessments', 'user_id', 'privacy_recovery_account_erasure_verification_assessments_remain'],
        ['identity_verification_consents', 'user_id', 'privacy_recovery_account_erasure_verification_identity_consent_remains'],
        ['identity_verification_session_reservations', 'user_id', 'privacy_recovery_account_erasure_verification_identity_reservations_remain'],
        ['identity_verification_events', 'user_id', 'privacy_recovery_account_erasure_verification_identity_events_remain'],
        ['identity_verifications', 'user_id', 'privacy_recovery_account_erasure_verification_identity_records_remain'],
        ['likes', 'sender_id = $1 OR target_id = $1', 'privacy_recovery_account_erasure_verification_likes_remain'],
        ['profile_passes', 'passer_id = $1 OR passed_user_id = $1', 'privacy_recovery_account_erasure_verification_passes_remain'],
        ['female_profile_exposures', 'user_id', 'privacy_recovery_account_erasure_verification_exposures_remain'],
        ['profile_preferences', 'user_id', 'privacy_recovery_account_erasure_verification_preferences_remain'],
        ['user_notifications', 'user_id', 'privacy_recovery_account_erasure_verification_notifications_remain'],
        ['account_action_tokens', 'user_id', 'privacy_recovery_account_erasure_verification_action_tokens_remain'],
        ['user_blocks', 'blocker_id = $1 OR blocked_id = $1', 'privacy_recovery_account_erasure_verification_blocks_remain'],
        ['photo_assets', 'user_id', 'privacy_recovery_account_erasure_verification_photo_metadata_remains'],
        ['profile_voice_intros', 'user_id', 'privacy_recovery_account_erasure_verification_voice_metadata_remains'],
        ['profile_voice_intro_consents', 'user_id', 'privacy_recovery_account_erasure_verification_voice_consent_remains'],
        ['profile_voice_intro_consent_events', 'user_id', 'privacy_recovery_account_erasure_verification_voice_consent_history_remains'],
        ['identity_l3_submissions', 'user_id', 'privacy_recovery_account_erasure_verification_l3_submissions_remain'],
        ['identity_l3_consents', 'user_id', 'privacy_recovery_account_erasure_verification_l3_consent_remains'],
        ['identity_l3_consent_events', 'user_id', 'privacy_recovery_account_erasure_verification_l3_consent_history_remains'],
        ['ad_consent_preferences', 'user_id', 'privacy_recovery_account_erasure_verification_ad_consent_remains'],
        ['ad_consent_history', 'user_id', 'privacy_recovery_account_erasure_verification_ad_history_remains'],
        ['ad_events', 'user_id', 'privacy_recovery_account_erasure_verification_ad_events_remain'],
        ['gift_receiving_preferences', 'user_id', 'privacy_recovery_account_erasure_verification_gift_preferences_remain']
      ];
      for (const [table, predicate, code] of scopedChecks) {
        await assertNoRows(client, `SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`, [userId], code);
      }

      await assertNoRows(client,
        "SELECT 1 FROM mobile_sessions WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_mobile_sessions_active');
      await assertNoRows(client,
        "SELECT 1 FROM messages WHERE sender_id = $1 AND (body <> '[сообщение удалено]' OR deleted_at IS NULL) LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_message_content_remains');
      await assertNoRows(client,
        "SELECT 1 FROM matches WHERE (user_a_id = $1 OR user_b_id = $1) AND status <> 'closed' LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_matches_open');
      await assertNoRows(client,
        "SELECT 1 FROM gift_delivery_orders WHERE (sender_id = $1 OR recipient_id = $1) AND (address_vault_ref IS NOT NULL OR status IN ('awaiting_recipient_consent','recipient_accepted','address_verified','fulfilment_authorized','dispatched','delivery_failed')) LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_gift_orders_unsafe');
      await assertNoRows(client,
        "SELECT 1 FROM gift_address_vault_entries v JOIN gift_delivery_orders o ON o.id = v.order_id WHERE o.sender_id = $1 OR o.recipient_id = $1 LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_gift_vault_remains');
      await assertNoRows(client,
        "SELECT 1 FROM gift_address_drafts d JOIN gift_delivery_orders o ON o.id = d.order_id WHERE o.sender_id = $1 OR o.recipient_id = $1 LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_gift_draft_remains');
      await assertNoRows(client,
        "SELECT 1 FROM paddle_checkout_attempts WHERE user_id = $1 AND status IN ('creating','pending','reconciliation_required') LIMIT 1",
        [userId], 'privacy_recovery_account_erasure_verification_checkout_unresolved');
      await assertNoRows(client,
        `SELECT 1
           FROM gift_address_draft_consent_events e
           JOIN gift_delivery_orders o ON o.id = e.order_id
           JOIN LATERAL (
             SELECT action FROM gift_address_draft_consent_events latest
              WHERE latest.order_id = e.order_id
                AND latest.recipient_user_id = e.recipient_user_id
              ORDER BY latest.id DESC LIMIT 1
           ) current_consent ON TRUE
          WHERE (o.sender_id = $1 OR o.recipient_id = $1)
            AND current_consent.action = 'granted'
          LIMIT 1`,
        [userId], 'privacy_recovery_account_erasure_verification_gift_draft_consent_active');
      await assertNoRows(client,
        `SELECT 1
           FROM gift_delivery_orders o
           JOIN LATERAL (
             SELECT from_status FROM gift_delivery_order_events
              WHERE order_id = o.id AND event_type = 'safety_hold'
              ORDER BY id DESC LIMIT 1
           ) safety_event ON TRUE
          WHERE (o.sender_id = $1 OR o.recipient_id = $1)
            AND safety_event.from_status NOT IN ('delivered', 'refund_pending')
            AND o.payment_status IN ('authorization_pending', 'authorized', 'captured', 'refund_pending')
            AND NOT EXISTS (
              SELECT 1 FROM gift_payment_reconciliation_tasks task
               WHERE task.order_id = o.id
            )
          LIMIT 1`,
        [userId], 'privacy_recovery_account_erasure_verification_gift_payment_reconciliation_missing');

      const reuse = await client.query(
        `SELECT 1 FROM account_reuse_restrictions
          WHERE email_hmac = $1 AND expires_at >= $2::timestamptz + INTERVAL '90 days'
          LIMIT 1`,
        [event.account_reuse_hmac, event.occurred_at]
      );
      if (!reuse.rowCount) throw new Error('privacy_recovery_account_erasure_verification_reuse_restriction_missing');

      const obligations = await client.query(
        `SELECT queue_name, storage_path_sha256 FROM privacy_recovery_replay_purge_obligations
          WHERE ledger_sequence = $1 AND event_id = $2`,
        [event.ledger_sequence, event.event_id]
      );
      if (obligations.rowCount !== Number(event.purge_count)) {
        throw new Error('privacy_recovery_account_erasure_verification_purge_obligations_missing');
      }
      const completions = await client.query(
        `SELECT queue_name, storage_path_sha256 FROM privacy_recovery_replay_purge_completions
          WHERE ledger_sequence = $1`,
        [event.ledger_sequence]
      );
      if (completions.rowCount !== obligations.rowCount) {
        throw new Error('privacy_recovery_account_erasure_verification_purge_completions_missing');
      }
      const photoQueue = await client.query('SELECT storage_path FROM private_photo_purge_queue');
      const voiceQueue = await client.query('SELECT storage_path FROM private_voice_intro_purge_queue');
      const queuedDigests = new Set([
        ...(photoQueue.rows || []).map(row => sha256(row.storage_path)),
        ...(voiceQueue.rows || []).map(row => sha256(row.storage_path))
      ]);
      for (const obligation of obligations.rows) {
        const completionCount = completions.rows.filter(row =>
          row.queue_name === obligation.queue_name &&
          row.storage_path_sha256 === obligation.storage_path_sha256
        ).length;
        if (completionCount !== 1 || queuedDigests.has(obligation.storage_path_sha256)) {
          throw new Error('privacy_recovery_account_erasure_verification_physical_purge_incomplete');
        }
      }
    }

    await client.query('COMMIT');
    open = false;
    return {
      complete: true,
      verifiedAccountErasureCount: verified.length,
      verifiedPurgeObligationCount: verified.reduce((sum, row) => sum + Number(row.purge_count), 0),
      throughSequence
    };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
