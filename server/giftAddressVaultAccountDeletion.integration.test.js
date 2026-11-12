import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('deleting either gift-order account revokes delivered address pointer but preserves delivery and payment evidence', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const matchId = randomUUID();
  const orderId = randomUUID();
  const idempotencyKey = 'gift-address-erasure-' + randomUUID();
  try {
    const installed = await client.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgname = 'users_revoke_deleted_account_gift_address_refs'
             AND tgrelid = 'users'::regclass
             AND NOT tgisinternal
         ) AS trigger_installed,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'gift_orders_address_required_until_delivery'
             AND conrelid = 'gift_delivery_orders'::regclass
         ) AS delivery_constraint_installed`
    );
    assert.equal(installed.rows[0].trigger_installed, true, 'migration 232 must install the account-erasure trigger');
    assert.equal(installed.rows[0].delivery_constraint_installed, true, 'migration 232 must allow address revocation after delivery');

    await client.query('BEGIN');
    try {
      await client.query(
        'INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, \'member\', \'active\', NOW()), ($3, $4, \'member\', \'active\', NOW())',
        [senderId, 'gift-address-sender-' + senderId + '@example.invalid', recipientId, 'gift-address-recipient-' + recipientId + '@example.invalid']
      );
      await client.query(
        'INSERT INTO matches (id, user_a_id, user_b_id, status, created_at) VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), \'active\', NOW())',
        [matchId, senderId, recipientId]
      );
      await client.query(
        `INSERT INTO gift_delivery_orders
           (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, idempotency_key, status, payment_status,
            recipient_consent_at, recipient_consent_version, address_vault_ref,
            address_verified_at, fulfilment_authorized_at, dispatched_at, delivered_at)
         VALUES
           ($1, $2, $3, $4, 'Address erasure test gift', 'chocolate',
            1500, 'USD', $5, 'delivered', 'captured',
            NOW() - INTERVAL '2 days', 1, 'vault:opaque-test-reference',
            NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days',
            NOW() - INTERVAL '1 day', NOW() - INTERVAL '12 hours')`,
        [orderId, matchId, senderId, recipientId, idempotencyKey]
      );

      await client.query(`UPDATE users SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [recipientId]);
      const result = await client.query(
        `SELECT status, payment_status, address_vault_ref, recipient_consent_at,
                address_verified_at, fulfilment_authorized_at, dispatched_at, delivered_at
         FROM gift_delivery_orders WHERE id = $1`,
        [orderId]
      );
      assert.equal(result.rowCount, 1);
      assert.equal(result.rows[0].status, 'delivered', 'account erasure must not rewrite completed delivery status');
      assert.equal(result.rows[0].payment_status, 'captured', 'account erasure must not rewrite financial state');
      assert.equal(result.rows[0].address_vault_ref, null, 'the private address pointer must be revoked');
      assert.ok(result.rows[0].recipient_consent_at, 'recipient-consent evidence must remain');
      assert.ok(result.rows[0].address_verified_at, 'address-verification timestamp evidence must remain');
      assert.ok(result.rows[0].fulfilment_authorized_at, 'fulfilment authorization evidence must remain');
      assert.ok(result.rows[0].dispatched_at, 'dispatch evidence must remain');
      assert.ok(result.rows[0].delivered_at, 'delivery evidence must remain');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
