import { createHash, createHmac } from 'node:crypto';
import {
  acquireGiftSafetyPairLock,
  acquireGiftSafetyUserLocks,
  notifyGiftRequestUpdate
} from './giftOrderCreationService.js';
import { evaluateGiftConsentWithdrawalEligibility } from './giftDeliveryPolicy.js';
import { revokeGiftAddressVaultEntry } from './giftAddressVault.js';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const EVENT_TYPE = 'gift_order_consent_withdrawn';
const OUTCOME = 'gift_order_consent_withdrawn';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertIsolated(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_gift_consent_requires_isolated_restore');
  }
  assertPrivacyRecoveryRestoreTargetConfig(env);
  if (typeof env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY !== 'string' ||
      env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY.length < 32) {
    throw new Error('privacy_recovery_gift_consent_pseudonym_key_required');
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

function assertMapping(row, mapping, key) {
  if (!mapping || mapping.status !== 'matched' || mapping.eventType !== EVENT_TYPE ||
      typeof mapping.subjectUserId !== 'string' || !UUID.test(mapping.subjectUserId) ||
      typeof mapping.resourceId !== 'string' || !UUID.test(mapping.resourceId) ||
      !row.resource_ref) {
    throw new Error('privacy_recovery_gift_consent_mapping_unresolved');
  }
  const expectedSubject = createHmac('sha256', key).update(mapping.subjectUserId, 'utf8').digest('hex');
  const expectedResource = createHmac('sha256', key).update(mapping.resourceId, 'utf8').digest('hex');
  if (expectedSubject !== String(row.subject_ref).toLowerCase() ||
      expectedResource !== String(row.resource_ref).toLowerCase()) {
    throw new Error('privacy_recovery_gift_consent_mapping_mismatch');
  }
}

function assertReceipt(receipt, mapping, digest) {
  if (String(receipt.ledger_sequence) !== String(mapping.sequence) ||
      receipt.event_id !== mapping.eventId || receipt.event_digest !== digest ||
      receipt.event_type !== EVENT_TYPE || receipt.outcome_code !== OUTCOME) {
    throw new Error('privacy_recovery_gift_consent_receipt_conflict');
  }
}

async function loadEligibleOrder(client, mapping, lock = false) {
  const order = await client.query(
    `SELECT id, sender_id, recipient_id, status,
            payment_status AS "paymentStatus",
            consent_withdrawn_at AS "consentWithdrawnAt",
            dispatched_at AS "dispatchedAt",
            public_reference
       FROM gift_delivery_orders
      WHERE id = $1 AND recipient_id = $2
      ${lock ? 'FOR UPDATE' : ''}`,
    [mapping.resourceId, mapping.subjectUserId]
  );
  if (order.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_order_unavailable');
  const eligibility = evaluateGiftConsentWithdrawalEligibility(order.rows[0]);
  if (!eligibility.eligible) throw new Error('privacy_recovery_gift_consent_order_not_withdrawable');
  return order.rows[0];
}

export async function preflightGiftConsentWithdrawalPrivacyRecovery({
  pool, mapping, pseudonymKey, env = process.env
}) {
  assertIsolated(env);
  if (!pool || typeof pool.connect !== 'function' || !mapping || mapping.eventType !== EVENT_TYPE) {
    throw new TypeError('privacy_recovery_gift_consent_preflight_input_invalid');
  }
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    open = true;
    await assertPrivacyRecoveryRestoreTarget(client, env);
    const receiptResult = await client.query(
      `SELECT ledger_sequence, event_id, event_digest, event_type, outcome_code
         FROM privacy_recovery_replay_receipts
        WHERE ledger_sequence = $1 OR event_id = $2`,
      [mapping.sequence, mapping.eventId]
    );
    const stagedResult = await client.query(
      `SELECT ledger_sequence, event_id, schema_version, event_type, subject_ref,
              resource_ref, occurred_at, received_at
         FROM privacy_recovery_events
        WHERE ledger_sequence = $1 AND event_id = $2`,
      [mapping.sequence, mapping.eventId]
    );
    if (stagedResult.rowCount !== 1 || stagedResult.rows[0].event_type !== EVENT_TYPE) {
      throw new Error('privacy_recovery_gift_consent_preflight_event_missing');
    }
    const staged = stagedResult.rows[0];
    const digest = digestEvent(staged);
    if (receiptResult.rowCount) {
      if (receiptResult.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_receipt_conflict');
      assertReceipt(receiptResult.rows[0], mapping, digest);
      await client.query('COMMIT');
      open = false;
      return { ready: true, alreadyApplied: true };
    }
    assertMapping(staged, mapping, pseudonymKey);

    const pair = await client.query(
      'SELECT sender_id, recipient_id FROM gift_delivery_orders WHERE id = $1 AND recipient_id = $2',
      [mapping.resourceId, mapping.subjectUserId]
    );
    if (pair.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_order_unavailable');
    const accountStates = await client.query(
      'SELECT id, status FROM users WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[pair.rows[0].sender_id, pair.rows[0].recipient_id]]
    );
    if (accountStates.rowCount !== 2 || accountStates.rows.some(account => account.status !== 'active')) {
      throw new Error('privacy_recovery_gift_consent_accounts_unavailable');
    }
    await loadEligibleOrder(client, mapping);
    await client.query('COMMIT');
    open = false;
    return { ready: true, alreadyApplied: false };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function applyGiftConsentWithdrawalPrivacyRecoveryEvent({
  pool, mapping, pseudonymKey, env = process.env
}) {
  assertIsolated(env);
  if (!pool || typeof pool.connect !== 'function' || !mapping || mapping.eventType !== EVENT_TYPE) {
    throw new TypeError('privacy_recovery_gift_consent_input_invalid');
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
      throw new Error('privacy_recovery_gift_consent_staged_event_missing');
    }
    const staged = stagedResult.rows[0];
    const digest = digestEvent(staged);
    if (receiptResult.rowCount) {
      if (receiptResult.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_receipt_conflict');
      assertReceipt(receiptResult.rows[0], mapping, digest);
      await client.query('COMMIT');
      open = false;
      return { applied: false, alreadyApplied: true, outcome: OUTCOME };
    }
    assertMapping(staged, mapping, pseudonymKey);

    const pair = await client.query(
      'SELECT sender_id, recipient_id FROM gift_delivery_orders WHERE id = $1 AND recipient_id = $2',
      [mapping.resourceId, mapping.subjectUserId]
    );
    if (pair.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_order_unavailable');
    const { sender_id: senderId, recipient_id: recipientId } = pair.rows[0];
    await acquireGiftSafetyUserLocks(client, senderId, recipientId);
    await acquireGiftSafetyPairLock(client, senderId, recipientId);
    const accountStates = await client.query(
      'SELECT id, status FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [[senderId, recipientId]]
    );
    if (accountStates.rowCount !== 2 || accountStates.rows.some(account => account.status !== 'active')) {
      throw new Error('privacy_recovery_gift_consent_accounts_unavailable');
    }

    const order = await loadEligibleOrder(client, mapping, true);
    const updated = await client.query(
      `UPDATE gift_delivery_orders
          SET status = 'cancelled',
              consent_withdrawn_at = statement_timestamp(),
              address_vault_ref = NULL,
              address_verified_at = NULL,
              updated_at = statement_timestamp()
        WHERE id = $1 AND recipient_id = $2
          AND status IN ('recipient_accepted', 'address_verified')
          AND consent_withdrawn_at IS NULL
        RETURNING public_reference`,
      [mapping.resourceId, recipientId]
    );
    if (updated.rowCount !== 1) throw new Error('privacy_recovery_gift_consent_order_not_withdrawable');

    await revokeGiftAddressVaultEntry(client, {
      orderId: mapping.resourceId,
      recipientUserId: recipientId,
      actorUserId: recipientId
    });
    await client.query(
      `INSERT INTO gift_delivery_order_events
         (order_id, actor_user_id, actor_type, event_type, from_status, to_status)
       VALUES ($1, $2, 'recipient', 'consent_withdrawn', $3, 'cancelled')`,
      [mapping.resourceId, recipientId, order.status]
    );
    await notifyGiftRequestUpdate(client, senderId, updated.rows[0].public_reference, 'consent_withdrawn');

    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, $4, $5)`,
      [mapping.sequence, mapping.eventId, digest, EVENT_TYPE, OUTCOME]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
       VALUES ($1, $2, $3, $4, $5, 0)`,
      [mapping.sequence, mapping.eventId, EVENT_TYPE, recipientId, mapping.resourceId]
    );
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
