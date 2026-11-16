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
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const matchId = randomUUID();
  const orderId = randomUUID();
  const ttlOrderId = randomUUID();
  const accountDeleteOrderId = randomUUID();
  try {
    const installed = await client.query(`
      SELECT
        to_regclass('gift_address_drafts') IS NOT NULL AS drafts,
        to_regclass('gift_address_draft_consent_events') IS NOT NULL AS consents,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'gift_address_draft_scope_guard' AND NOT tgisinternal) AS scope_guard,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'gift_orders_purge_temporary_address_draft' AND NOT tgisinternal) AS order_purge,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_purge_deleted_gift_address_drafts' AND NOT tgisinternal) AS account_purge
    `);
    assert.deepEqual(installed.rows[0], { drafts: true, consents: true, scope_guard: true, order_purge: true, account_purge: true });

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

    await client.query("UPDATE users SET status = 'deleted', updated_at = NOW() WHERE id = $1", [recipientId]);
    const [deletedDraft, deletedConsent] = await Promise.all([
      client.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [accountDeleteOrderId]),
      client.query('SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [accountDeleteOrderId])
    ]);
    assert.equal(deletedDraft.rowCount, 0, 'account tombstoning must delete temporary ciphertext');
    assert.equal(deletedConsent.rows[0].action, 'withdrawn');

    await client.query('BEGIN');
    await client.query(`UPDATE gift_delivery_orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
    const [draft, consent] = await Promise.all([
      client.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [orderId]),
      client.query('SELECT action FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId])
    ]);
    assert.equal(draft.rowCount, 0, 'leaving recipient_accepted must physically remove the ciphertext row');
    assert.equal(consent.rows[0].action, 'withdrawn');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.query('SET session_replication_role = replica').catch(() => {});
    await client.query('DELETE FROM gift_address_drafts WHERE order_id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId]]).catch(() => {});
    await client.query('DELETE FROM gift_address_draft_consent_events WHERE order_id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId]]).catch(() => {});
    await client.query('DELETE FROM gift_delivery_orders WHERE id = ANY($1::uuid[])', [[orderId, ttlOrderId, accountDeleteOrderId]]).catch(() => {});
    await client.query('DELETE FROM matches WHERE id = $1', [matchId]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[senderId, recipientId]]).catch(() => {});
    await client.query('SET session_replication_role = origin').catch(() => {});
    client.release();
    await pool.end();
  }
});
