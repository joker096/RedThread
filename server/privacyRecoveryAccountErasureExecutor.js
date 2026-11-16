import { createHash, createHmac } from 'node:crypto';
import { acquireGiftSafetyUserLocks } from './giftOrderCreationService.js';
import { revokeGiftAddressVaultEntry } from './giftAddressVault.js';
import { normalizeGiftSafetyAuditReason } from './giftDeliveryPolicy.js';
import { createAccountReuseDigest } from './security.js';
import { queuePrivatePhotoPurges } from './photoPurge.js';
import { queuePrivateVoiceIntroPurges } from './voiceIntroStorage.js';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const EVENT_TYPE = 'account_erasure_requested';
const OUTCOME = 'account_erasure_replayed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertIsolated(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_account_erasure_requires_isolated_restore');
  }
  assertPrivacyRecoveryRestoreTargetConfig(env);
  if (typeof env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY !== 'string' ||
      env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY.length < 32) {
    throw new Error('privacy_recovery_account_erasure_pseudonym_key_required');
  }
  if (typeof env.ACCOUNT_REUSE_HMAC_KEY !== 'string' || env.ACCOUNT_REUSE_HMAC_KEY.length < 32) {
    throw new Error('privacy_recovery_account_erasure_reuse_key_required');
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

function assertSubjectMapping(row, mapping, key) {
  if (!mapping || mapping.status !== 'matched' || mapping.eventType !== EVENT_TYPE ||
      typeof mapping.subjectUserId !== 'string' || !UUID.test(mapping.subjectUserId)) {
    throw new Error('privacy_recovery_account_erasure_mapping_unresolved');
  }
  const expected = createHmac('sha256', key).update(mapping.subjectUserId, 'utf8').digest('hex');
  if (expected !== String(row.subject_ref).toLowerCase()) {
    throw new Error('privacy_recovery_account_erasure_subject_mapping_mismatch');
  }
}

async function holdGiftOrders(client, userId) {
  const pairs = await client.query(
    `SELECT DISTINCT LEAST(sender_id, recipient_id)::text AS user_a,
            GREATEST(sender_id, recipient_id)::text AS user_b
       FROM gift_delivery_orders
      WHERE (sender_id = $1 OR recipient_id = $1)
        AND (
          status IN ('awaiting_recipient_consent', 'recipient_accepted', 'address_verified',
                     'fulfilment_authorized', 'dispatched', 'delivery_failed')
          OR (address_vault_ref IS NOT NULL AND status <> 'delivered')
        )
      ORDER BY user_a, user_b`,
    [userId]
  );
  for (const pair of pairs.rows) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('gift-safety:' || $1 || ':' || $2))",
      [pair.user_a, pair.user_b]
    );
  }

  const suspended = await client.query(
    `WITH candidates AS (
       SELECT id, status AS previous_status, (address_vault_ref IS NOT NULL) AS had_address_pointer
         FROM gift_delivery_orders
        WHERE (sender_id = $1 OR recipient_id = $1)
          AND (
            status IN ('awaiting_recipient_consent', 'recipient_accepted', 'address_verified',
                       'fulfilment_authorized', 'dispatched', 'delivery_failed')
            OR (address_vault_ref IS NOT NULL AND status <> 'delivered')
          )
        ORDER BY id
        FOR UPDATE
     )
     UPDATE gift_delivery_orders AS o
        SET status = CASE
              WHEN c.previous_status IN ('dispatched', 'delivery_failed') THEN 'reported'
              WHEN c.previous_status IN ('reported', 'blocked', 'delivered', 'declined',
                                         'expired', 'cancelled', 'refund_pending', 'refunded')
                THEN c.previous_status
              ELSE 'blocked'
            END,
            address_vault_ref = NULL,
            address_verified_at = NULL,
            updated_at = statement_timestamp()
       FROM candidates AS c
      WHERE o.id = c.id
      RETURNING o.id, o.recipient_id, c.previous_status, c.had_address_pointer,
                o.status AS next_status, o.payment_status`,
    [userId]
  );

  for (const gift of suspended.rows) {
    if (gift.had_address_pointer) {
      await revokeGiftAddressVaultEntry(client, {
        orderId: gift.id,
        recipientUserId: gift.recipient_id,
        actorUserId: null
      });
    }
    await client.query(
      `INSERT INTO gift_delivery_order_events
         (order_id, actor_user_id, actor_type, event_type, from_status, to_status, metadata)
       VALUES ($1, NULL, 'system', 'safety_hold', $2, $3, $4::jsonb)`,
      [gift.id, gift.previous_status, gift.next_status, JSON.stringify({
        reason: normalizeGiftSafetyAuditReason('account_deleted'),
        addressRevoked: gift.had_address_pointer
      })]
    );
    if (gift.previous_status !== 'delivered' && gift.previous_status !== 'refund_pending' &&
        ['authorization_pending', 'authorized', 'captured', 'refund_pending'].includes(gift.payment_status)) {
      await client.query(
        `INSERT INTO gift_payment_reconciliation_tasks (order_id, reason)
         VALUES ($1, 'safety_hold') ON CONFLICT DO NOTHING`,
        [gift.id]
      );
      await client.query(
        `INSERT INTO gift_delivery_order_events
           (order_id, actor_user_id, actor_type, event_type, from_status, to_status, metadata)
         SELECT id, NULL, 'system', 'payment_reconciliation_required', status, status,
                jsonb_build_object('reason', 'safety_hold')
           FROM gift_delivery_orders
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM gift_delivery_order_events e
               WHERE e.order_id = gift_delivery_orders.id
                 AND e.event_type = 'payment_reconciliation_required'
                 AND e.metadata->>'reason' = 'safety_hold'
            )`,
        [gift.id]
      );
    }
  }
}

async function applyAccountErasure(client, userId, env, eventOccurredAt) {
  await acquireGiftSafetyUserLocks(client, userId);
  const userResult = await client.query(
    `SELECT id, email, status, paddle_customer_id, paddle_subscription_id,
            paddle_subscription_status, premium_until, premium_lifetime
       FROM users WHERE id = $1 FOR UPDATE`,
    [userId]
  );
  if (userResult.rowCount !== 1 || userResult.rows[0].status !== 'active') {
    throw new Error('privacy_recovery_account_erasure_subject_state_conflict');
  }
  const user = userResult.rows[0];
  const reuseDigest = createAccountReuseDigest(user.email, env.ACCOUNT_REUSE_HMAC_KEY);
  if (!reuseDigest) throw new Error('privacy_recovery_account_erasure_reuse_digest_unavailable');

  const checkout = await client.query(
    `SELECT status, plan FROM paddle_checkout_attempts WHERE user_id = $1 FOR UPDATE`,
    [userId]
  );
  if (checkout.rows.some(row => ['creating', 'pending', 'completed', 'reconciliation_required'].includes(row.status) &&
      !(row.status === 'completed' && row.plan === 'lifetime'))) {
    throw new Error('privacy_recovery_account_erasure_paddle_checkout_unresolved');
  }
  const subscriptionStatus = String(user.paddle_subscription_status || '').toLowerCase();
  if ((user.paddle_subscription_id && !['canceled', 'completed'].includes(subscriptionStatus)) ||
      (!user.paddle_subscription_id && subscriptionStatus && !['canceled', 'completed'].includes(subscriptionStatus))) {
    throw new Error('privacy_recovery_account_erasure_paddle_subscription_unresolved');
  }
  const erasureTime = Date.parse(eventOccurredAt);
  if (!Number.isFinite(erasureTime)) throw new Error('privacy_recovery_account_erasure_event_time_invalid');
  if (user.premium_lifetime !== true && user.premium_until &&
      new Date(user.premium_until).getTime() > erasureTime) {
    throw new Error('privacy_recovery_account_erasure_premium_state_unresolved');
  }

  const l3Media = await client.query(
    'SELECT id FROM identity_l3_submissions WHERE user_id = $1 AND storage_object_key IS NOT NULL FOR UPDATE',
    [userId]
  );
  if (l3Media.rowCount) throw new Error('privacy_recovery_account_erasure_l3_media_unresolved');

  await holdGiftOrders(client, userId);

  const photos = await client.query('SELECT storage_path FROM photo_assets WHERE user_id = $1 FOR UPDATE', [userId]);
  const voices = await client.query('SELECT storage_path FROM profile_voice_intros WHERE user_id = $1 FOR UPDATE', [userId]);
  const photoPaths = photos.rows.map(row => row.storage_path);
  const voicePaths = voices.rows.map(row => row.storage_path);
  await queuePrivatePhotoPurges(client, photoPaths);
  await queuePrivateVoiceIntroPurges(client, voicePaths);
  await client.query('DELETE FROM identity_l3_submissions WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM photo_assets WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM profile_voice_intros WHERE user_id = $1', [userId]);

  await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM relationship_assessments WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM identity_verification_consents WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM identity_verification_session_reservations WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM identity_verification_events WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM identity_verifications WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM likes WHERE sender_id = $1 OR target_id = $1', [userId]);
  await client.query('DELETE FROM profile_passes WHERE passer_id = $1 OR passed_user_id = $1', [userId]);
  await client.query('DELETE FROM female_profile_exposures WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM profile_preferences WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM user_notifications WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM account_action_tokens WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
  await client.query(
    "UPDATE messages SET body = '[сообщение удалено]', deleted_at = COALESCE(deleted_at, statement_timestamp()) WHERE sender_id = $1",
    [userId]
  );
  await client.query(
    `UPDATE profiles SET
       display_name = 'Удалённый пользователь', birth_date = NULL,
       country = '—', city = '—', bio = '', photo_urls = '{}',
       occupation = '', education = '', languages = '{}', is_visible = FALSE,
       has_children = NULL, children_disclosure_confirmed_at = NULL,
       family_format = 'open_to_both', wants_children = 'discuss',
       children_living_arrangement = 'not_applicable', updated_at = statement_timestamp()
     WHERE user_id = $1`,
    [userId]
  );
  await client.query(
    `UPDATE mobile_sessions SET revoked_at = NOW(), revoked_reason = 'account_unavailable'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  await client.query(
    `UPDATE users SET status = 'deleted', email = $2, password_hash = NULL,
       phone_e164 = NULL, phone_verified_at = NULL, female_trial_ends_at = NULL,
       premium_until = NULL, premium_lifetime = FALSE, updated_at = statement_timestamp()
     WHERE id = $1 AND status = 'active'`,
    [userId, 'deleted+' + userId + '@deleted.invalid']
  );

  await client.query('DELETE FROM profile_voice_intro_consent_events WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM profile_voice_intro_consents WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM identity_l3_consent_events WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM identity_l3_consents WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM ad_consent_preferences WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM ad_consent_history WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM gift_receiving_preferences WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM ad_events WHERE user_id = $1', [userId]);
  await client.query(
    "UPDATE matches SET status = 'closed' WHERE user_a_id = $1 OR user_b_id = $1",
    [userId]
  );
  await client.query(
    `INSERT INTO account_reuse_restrictions (email_hmac, expires_at)
     VALUES ($1, clock_timestamp() + INTERVAL '90 days')
     ON CONFLICT (email_hmac) DO UPDATE
     SET expires_at = GREATEST(account_reuse_restrictions.expires_at, EXCLUDED.expires_at)`,
    [reuseDigest]
  );
  return { purgePaths: [
    ...photoPaths.map(storagePath => ({ queue: 'private_photo', storagePath })),
    ...voicePaths.map(storagePath => ({ queue: 'private_voice_intro', storagePath }))
  ] };
}

/** Replay one account erasure atomically in a guarded isolated restore only. */
export async function applyAccountErasurePrivacyRecoveryEvent({
  pool, mapping, pseudonymKey, env = process.env
}) {
  assertIsolated(env);
  if (!pool || typeof pool.connect !== 'function' || !mapping || mapping.eventType !== EVENT_TYPE) {
    throw new TypeError('privacy_recovery_account_erasure_input_invalid');
  }
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    await assertPrivacyRecoveryRestoreTarget(client, env);

    const receiptResult = await client.query(
      `SELECT ledger_sequence, event_id, event_digest, event_type, outcome_code
         FROM privacy_recovery_replay_receipts
        WHERE ledger_sequence = $1 OR event_id = $2 FOR UPDATE`,
      [mapping.sequence, mapping.eventId]
    );
    const stagedResult = await client.query(
      `SELECT ledger_sequence, event_id, schema_version, event_type, subject_ref,
              resource_ref, occurred_at, received_at
         FROM privacy_recovery_events
        WHERE ledger_sequence = $1 AND event_id = $2 FOR SHARE`,
      [mapping.sequence, mapping.eventId]
    );
    if (stagedResult.rowCount !== 1 || stagedResult.rows[0].event_type !== EVENT_TYPE) {
      throw new Error('privacy_recovery_account_erasure_staged_event_missing');
    }
    const staged = stagedResult.rows[0];
    const digest = digestEvent(staged);
    if (receiptResult.rowCount) {
      const receipt = receiptResult.rows[0];
      if (receiptResult.rowCount !== 1 ||
          String(receipt.ledger_sequence) !== String(mapping.sequence) ||
          receipt.event_id !== mapping.eventId || receipt.event_digest !== digest ||
          receipt.event_type !== EVENT_TYPE || receipt.outcome_code !== OUTCOME) {
        throw new Error('privacy_recovery_account_erasure_receipt_conflict');
      }
      await client.query('COMMIT');
      open = false;
      return { applied: false, alreadyApplied: true, outcome: OUTCOME };
    }

    assertSubjectMapping(staged, mapping, pseudonymKey);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`gift-safety-user:${mapping.subjectUserId}`]
    );
    const concurrentReceipt = await client.query(
      `SELECT ledger_sequence, event_id, event_digest, event_type, outcome_code
         FROM privacy_recovery_replay_receipts
        WHERE ledger_sequence = $1 OR event_id = $2 FOR UPDATE`,
      [mapping.sequence, mapping.eventId]
    );
    if (concurrentReceipt.rowCount) {
      const receipt = concurrentReceipt.rows[0];
      if (concurrentReceipt.rowCount !== 1 ||
          String(receipt.ledger_sequence) !== String(mapping.sequence) ||
          receipt.event_id !== mapping.eventId || receipt.event_digest !== digest ||
          receipt.event_type !== EVENT_TYPE || receipt.outcome_code !== OUTCOME) {
        throw new Error('privacy_recovery_account_erasure_receipt_conflict');
      }
      await client.query('COMMIT');
      open = false;
      return { applied: false, alreadyApplied: true, outcome: OUTCOME };
    }
    const applied = await applyAccountErasure(client, mapping.subjectUserId, env, staged.occurred_at);
    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, $4, $5)`,
      [mapping.sequence, mapping.eventId, digest, EVENT_TYPE, OUTCOME]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [mapping.sequence, mapping.eventId, EVENT_TYPE, mapping.subjectUserId, applied.purgePaths.length]
    );
    if (applied.purgePaths.length) {
      const obligations = applied.purgePaths.map(item => [
        mapping.sequence, mapping.eventId, item.queue,
        createHash('sha256').update(item.storagePath, 'utf8').digest('hex')
      ]);
      await client.query(
        `INSERT INTO privacy_recovery_replay_purge_obligations
           (ledger_sequence, event_id, queue_name, storage_path_sha256)
         SELECT item.ledger_sequence, item.event_id, item.queue_name, item.storage_path_sha256
           FROM jsonb_to_recordset($1::jsonb) AS item(
             ledger_sequence BIGINT, event_id UUID, queue_name TEXT, storage_path_sha256 TEXT
           )`,
        [JSON.stringify(obligations)]
      );
    }
    await client.query('COMMIT');
    open = false;
    return { applied: true, alreadyApplied: false, outcome: OUTCOME };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
