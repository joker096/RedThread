import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { purgeExpiredGiftAddressDrafts } from './giftAddressDraftPurge.js';

const { Pool } = pg;

test('temporary gift address drafts are isolated, consent-bound, and purged on state changes and TTL', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock(434236)');
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const matchId = randomUUID();
  const orderId = randomUUID();
  const ttlOrderId = randomUUID();
  const accountDeleteOrderId = randomUUID();
  const matchPurgeOrderId = randomUUID();
  const auditActorId = randomUUID();
  try {
    const installed = await client.query(`
      SELECT
        to_regclass('gift_address_drafts') IS NOT NULL AS drafts,
        to_regclass('gift_address_draft_consent_events') IS NOT NULL AS consents,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'gift_address_draft_scope_guard' AND NOT tgisinternal) AS scope_guard,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'gift_orders_purge_temporary_address_draft' AND NOT tgisinternal) AS order_purge,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_purge_inactive_gift_address_drafts' AND NOT tgisinternal) AS account_purge,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'matches_purge_inactive_gift_address_drafts' AND NOT tgisinternal) AS match_purge,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_blocks_purge_gift_address_drafts' AND NOT tgisinternal) AS block_purge,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_reports_purge_gift_address_drafts' AND NOT tgisinternal) AS report_purge,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_safety_screenings_purge_gift_address_drafts' AND NOT tgisinternal) AS screening_purge
    `);
    assert.deepEqual(installed.rows[0], {
      drafts: true, consents: true, scope_guard: true, order_purge: true,
      account_purge: true, match_purge: true, block_purge: true,
      report_purge: true, screening_purge: true
    });

    const consentActorConstraint = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'gift_address_draft_consent_events'::regclass
          AND conname = 'gift_address_draft_consent_grant_actor_required_check'`
    );
    assert.equal(consentActorConstraint.rowCount, 1,
      'migration 251 must require a recipient actor for granted consent');

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, role, status, email_verified_at)
       VALUES ($1, $2, 'member', 'active', NOW()), ($3, $4, 'member', 'active', NOW())`,
      [senderId, `draft-sender-${senderId}@example.invalid`, recipientId, `draft-recipient-${recipientId}@example.invalid`]
    );
    await client.query(
      `INSERT INTO matches (id, user_a_id, user_b_id, status, created_at)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW())`,
      [matchId, senderId, recipientId]
    );

    for (const id of [orderId, ttlOrderId, accountDeleteOrderId]) {
      await client.query(
        `INSERT INTO gift_delivery_orders
           (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, idempotency_key, status, payment_status,
            recipient_consent_at, recipient_consent_version)
         VALUES ($1, $2, $3, $4, 'Temporary draft test', 'chocolate',
                 1000, 'GEL', $5, 'recipient_accepted', 'not_started', NOW(), 1)`,
        [id, matchId, senderId, recipientId, 'draft-' + id]
      );
      await client.query(
        `INSERT INTO gift_address_draft_consent_events
           (order_id, recipient_user_id, consent_version, action, actor_user_id)
         VALUES ($1, $2, 1, 'granted', $2)`,
        [id, recipientId]
      );
    }

    await client.query('SAVEPOINT missing_consent_actor');
    await assert.rejects(
      client.query(
        `INSERT INTO gift_address_draft_consent_events
           (order_id, recipient_user_id, consent_version, action, actor_user_id)
         VALUES ($1, $2, 1, 'granted', NULL)`,
        [orderId, recipientId]
      ),
      error => error.code === '23514',
      'granted consent must not pass with a missing actor'
    );
    await client.query('ROLLBACK TO SAVEPOINT missing_consent_actor');
    await client.query('RELEASE SAVEPOINT missing_consent_actor');

    const nonce = Buffer.alloc(12, 11);
    const tag = Buffer.alloc(16, 12);
    const ciphertext = Buffer.from('AES-GCM-ciphertext-only');
    await client.query(
      `INSERT INTO gift_address_drafts
         (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, expires_at)
       VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
      [orderId, recipientId, nonce, tag, ciphertext]
    );
    await client.query(
      `INSERT INTO gift_address_drafts
         (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, created_at, expires_at)
       VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      [ttlOrderId, recipientId, nonce, tag, ciphertext]
    );
    await client.query(
      `INSERT INTO gift_address_drafts
         (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, expires_at)
       VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
      [accountDeleteOrderId, recipientId, nonce, tag, ciphertext]
    );

    await client.query('SAVEPOINT immutable_consent');
    await assert.rejects(
      client.query(
        `UPDATE gift_address_draft_consent_events SET action = 'withdrawn' WHERE order_id = $1`,
        [orderId]
      ),
      error => error.code === '23514',
      'consent events must be append-only'
    );
    await client.query('ROLLBACK TO SAVEPOINT immutable_consent');
    await client.query('RELEASE SAVEPOINT immutable_consent');
    await client.query('COMMIT');

    const mainOrder = await client.query(
      'SELECT status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
      [orderId]
    );
    assert.equal(mainOrder.rows[0].status, 'recipient_accepted');
    assert.equal(mainOrder.rows[0].address_vault_ref, null);
    assert.equal(mainOrder.rows[0].address_verified_at, null);

    await client.query('BEGIN');
    await client.query('SAVEPOINT forbid_main_vault_write');
    await assert.rejects(
      client.query(
        `INSERT INTO gift_address_vault_entries
           (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext)
         VALUES ($1, $2, 'draft-must-not-enter-vault', $3, $4, $5)`,
        [orderId, recipientId, Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from('temporary-draft')]
      ),
      error => error.code === '23514',
      'the database must reject even a transient write of a recipient_accepted draft into the verified-address Vault'
    );
    await client.query('ROLLBACK TO SAVEPOINT forbid_main_vault_write');
    await client.query('RELEASE SAVEPOINT forbid_main_vault_write');
    await client.query('COMMIT');

    await client.query('BEGIN');
    await client.query('SAVEPOINT wrong_recipient');
    await assert.rejects(
      client.query(
        `INSERT INTO gift_address_drafts
           (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, expires_at)
         VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
        [orderId, senderId, nonce, tag, ciphertext]
      ),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT wrong_recipient');
    await client.query('RELEASE SAVEPOINT wrong_recipient');
    await client.query('COMMIT');

    const purged = await purgeExpiredGiftAddressDrafts(pool, { batchSize: 10 });
    assert.deepEqual(purged, { purged: 1 });
    const ttlState = await client.query(
      `SELECT d.order_id, latest.action
         FROM gift_address_drafts d
         JOIN LATERAL (
           SELECT action FROM gift_address_draft_consent_events
            WHERE order_id = d.order_id ORDER BY id DESC LIMIT 1
         ) latest ON TRUE
        WHERE d.order_id = $1`,
      [ttlOrderId]
    );
    assert.equal(ttlState.rowCount, 0);
    const ttlConsent = await client.query(
      'SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
      [ttlOrderId]
    );
    assert.equal(ttlConsent.rows[0].action, 'expired');

    await client.query('BEGIN');
    await client.query(`UPDATE gift_delivery_orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
    const [draft, consent] = await Promise.all([
      client.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [orderId]),
      client.query('SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId])
    ]);
    assert.equal(draft.rowCount, 0, 'leaving recipient_accepted must physically remove the ciphertext row');
    assert.equal(consent.rows[0].action, 'withdrawn');
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO gift_delivery_orders
         (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category,
          total_minor_units, currency, idempotency_key, status, payment_status,
          recipient_consent_at, recipient_consent_version)
       VALUES ($1, $2, $3, $4, 'Match deactivation test', 'chocolate',
               1000, 'GEL', $5, 'recipient_accepted', 'not_started', NOW(), 1)`,
      [matchPurgeOrderId, matchId, senderId, recipientId, 'draft-' + matchPurgeOrderId]
    );
    await client.query(
      `INSERT INTO gift_address_draft_consent_events
         (order_id, recipient_user_id, consent_version, action, actor_user_id)
       VALUES ($1, $2, 1, 'granted', $2)`,
      [matchPurgeOrderId, recipientId]
    );
    await client.query(
      `INSERT INTO gift_address_drafts
         (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, expires_at)
       VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
      [matchPurgeOrderId, recipientId, nonce, tag, ciphertext]
    );
    await client.query(`UPDATE matches SET status = 'blocked' WHERE id = $1`, [matchId]);
    const [matchDraft, matchConsent] = await Promise.all([
      client.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [matchPurgeOrderId]),
      client.query('SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [matchPurgeOrderId])
    ]);
    assert.equal(matchDraft.rowCount, 0, 'match deactivation must delete the temporary ciphertext');
    assert.equal(matchConsent.rows[0].action, 'withdrawn');
    await client.query('ROLLBACK');

    // High-risk screening must physically purge existing ciphertext and
    // the database scope guard must reject any later direct write.
    await client.query('BEGIN');
    const screeningRecipientId = randomUUID();
    const screeningMatchId = randomUUID();
    const screeningOrderId = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, role, status, email_verified_at)
       VALUES ($1, $2, 'member', 'active', NOW())`,
      [screeningRecipientId, `draft-screening-${screeningRecipientId}@example.invalid`]
    );
    await client.query(
      `INSERT INTO matches (id, user_a_id, user_b_id, status, created_at)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW())`,
      [screeningMatchId, senderId, screeningRecipientId]
    );
    await client.query(
      `INSERT INTO gift_delivery_orders
         (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category,
          total_minor_units, currency, idempotency_key, status, payment_status,
          recipient_consent_at, recipient_consent_version)
       VALUES ($1, $2, $3, $4, 'Screening purge test', 'chocolate',
               1000, 'GEL', $5, 'recipient_accepted', 'not_started', NOW(), 1)`,
      [screeningOrderId, screeningMatchId, senderId, screeningRecipientId, 'draft-' + screeningOrderId]
    );
    await client.query(
      `INSERT INTO gift_address_draft_consent_events
         (order_id, recipient_user_id, consent_version, action, actor_user_id)
       VALUES ($1, $2, 1, 'granted', $2)`,
      [screeningOrderId, screeningRecipientId]
    );
    await client.query(
      `INSERT INTO gift_address_drafts
         (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, expires_at)
       VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
      [screeningOrderId, screeningRecipientId, nonce, tag, ciphertext]
    );
    await client.query(
      `INSERT INTO user_safety_screenings (user_id, scope, severity, review_status)
       VALUES ($1, 'profile', 'high', 'pending')`,
      [screeningRecipientId]
    );
    const [screeningDraft, screeningConsent] = await Promise.all([
      client.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [screeningOrderId]),
      client.query('SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [screeningOrderId])
    ]);
    assert.equal(screeningDraft.rowCount, 0, 'high-risk screening must physically delete temporary ciphertext');
    assert.equal(screeningConsent.rows[0].action, 'withdrawn');

    // Simulate an internal caller attempting to re-grant and bypass the API.
    await client.query(
      `INSERT INTO gift_address_draft_consent_events
         (order_id, recipient_user_id, consent_version, action, actor_user_id)
       VALUES ($1, $2, 1, 'granted', $2)`,
      [screeningOrderId, screeningRecipientId]
    );
    await client.query('SAVEPOINT high_risk_scope_guard');
    await assert.rejects(
      client.query(
        `INSERT INTO gift_address_drafts
           (order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext, expires_at)
         VALUES ($1, $2, 'draft-v1', $3, $4, $5, NOW() + INTERVAL '1 hour')`,
        [screeningOrderId, screeningRecipientId, nonce, tag, ciphertext]
      ),
      error => error.code === '23514',
      'database scope guard must reject writes while a high-risk screening is active'
    );
    await client.query('ROLLBACK TO SAVEPOINT high_risk_scope_guard');
    await client.query('ROLLBACK');

    await client.query("UPDATE users SET status = 'deleted', updated_at = NOW() WHERE id = $1", [recipientId]);
    const [deletedDraft, deletedConsent] = await Promise.all([
      client.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [accountDeleteOrderId]),
      client.query('SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [accountDeleteOrderId])
    ]);
    assert.equal(deletedDraft.rowCount, 0, 'account tombstoning must delete temporary ciphertext');
    assert.equal(deletedConsent.rows[0].action, 'withdrawn');

    // A non-recipient actor can be erased without rewriting immutable consent history.
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, 'member', 'active', NOW())",
      [auditActorId, `draft-audit-actor-${auditActorId}@example.invalid`]
    );
    await client.query(
      `INSERT INTO gift_address_draft_consent_events
         (order_id, recipient_user_id, consent_version, action, actor_user_id)
       VALUES ($1, $2, 1, 'withdrawn', $3)`,
      [accountDeleteOrderId, recipientId, auditActorId]
    );
    const actorSnapshotBefore = await client.query(
      'SELECT actor_user_id, actor_ref FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
      [accountDeleteOrderId]
    );
    assert.equal(actorSnapshotBefore.rows[0].actor_user_id, auditActorId);
    assert.equal(actorSnapshotBefore.rows[0].actor_ref, auditActorId);

    await client.query(
      `INSERT INTO gift_delivery_order_events
         (order_id, actor_user_id, actor_type, event_type, metadata)
       VALUES ($1, $2, 'system', 'safety_hold', '{}'::jsonb)`,
      [accountDeleteOrderId, auditActorId]
    );
    const giftEventBefore = await client.query(
      'SELECT actor_user_id, actor_ref FROM gift_delivery_order_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
      [accountDeleteOrderId]
    );
    assert.equal(giftEventBefore.rows[0].actor_user_id, auditActorId);
    assert.equal(giftEventBefore.rows[0].actor_ref, auditActorId);

    await client.query('SAVEPOINT forbid_direct_gift_event_actor_null');
    await assert.rejects(
      client.query(
        'UPDATE gift_delivery_order_events SET actor_user_id = NULL WHERE order_id = $1 AND actor_user_id = $2',
        [accountDeleteOrderId, auditActorId]
      ),
      error => error.code === '55000',
      'direct gift-event actor nulling must be rejected'
    );
    await client.query('ROLLBACK TO SAVEPOINT forbid_direct_gift_event_actor_null');
    await client.query('RELEASE SAVEPOINT forbid_direct_gift_event_actor_null');

    await client.query('SAVEPOINT forbid_direct_actor_null');
    await assert.rejects(
      client.query(
        'UPDATE gift_address_draft_consent_events SET actor_user_id = NULL WHERE order_id = $1 AND actor_user_id = $2',
        [accountDeleteOrderId, auditActorId]
      ),
      error => error.code === '23514',
      'direct actor nulling must not imitate the FK account-erasure action'
    );
    await client.query('ROLLBACK TO SAVEPOINT forbid_direct_actor_null');
    await client.query('RELEASE SAVEPOINT forbid_direct_actor_null');

    await client.query('DELETE FROM users WHERE id = $1', [auditActorId]);
    const actorSnapshotAfter = await client.query(
      'SELECT actor_user_id, actor_ref FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
      [accountDeleteOrderId]
    );
    assert.equal(actorSnapshotAfter.rows[0].actor_user_id, null,
      'FK account erasure may clear only the live actor reference');
    assert.equal(actorSnapshotAfter.rows[0].actor_ref, auditActorId,
      'immutable actor snapshot must preserve original provenance');

    const giftEventAfter = await client.query(
      'SELECT actor_user_id, actor_ref FROM gift_delivery_order_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
      [accountDeleteOrderId]
    );
    assert.equal(giftEventAfter.rows[0].actor_user_id, null,
      'FK account erasure may clear only the gift-event live actor reference');
    assert.equal(giftEventAfter.rows[0].actor_ref, auditActorId,
      'gift-event actor provenance must remain immutable after account erasure');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.query('ALTER TABLE gift_address_draft_consent_events DISABLE TRIGGER gift_address_draft_consent_events_immutable').catch(() => {});
    await client.query('ALTER TABLE gift_delivery_order_events DISABLE TRIGGER gift_delivery_order_events_append_only').catch(() => {});
    await client.query('ALTER TABLE gift_delivery_orders DISABLE TRIGGER gift_delivery_orders_no_delete').catch(() => {});
    await client.query('DELETE FROM gift_address_drafts WHERE order_id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId, matchPurgeOrderId]]).catch(() => {});
    await client.query('DELETE FROM gift_address_draft_consent_events WHERE order_id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId, matchPurgeOrderId]]).catch(() => {});
    await client.query('DELETE FROM gift_delivery_order_events WHERE order_id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId, matchPurgeOrderId]]).catch(() => {});
    await client.query('DELETE FROM gift_delivery_orders WHERE id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId, matchPurgeOrderId]]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = $1', [auditActorId]).catch(() => {});
    await client.query('DELETE FROM matches WHERE id = $1', [matchId]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[senderId, recipientId]]).catch(() => {});
    await client.query('ALTER TABLE gift_address_draft_consent_events ENABLE TRIGGER gift_address_draft_consent_events_immutable').catch(() => {});
    await client.query('ALTER TABLE gift_delivery_order_events ENABLE TRIGGER gift_delivery_order_events_append_only').catch(() => {});
    await client.query('ALTER TABLE gift_delivery_orders ENABLE TRIGGER gift_delivery_orders_no_delete').catch(() => {});
    await client.query('SELECT pg_advisory_unlock(434236)').catch(() => {});
    client.release();
    await pool.end();
  }
});
