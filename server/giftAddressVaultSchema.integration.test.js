import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('encrypted gift address rows are order/recipient scoped and purged on account tombstoning', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const matchId = randomUUID();
  const orderId = randomUUID();
  const vaultRef = randomUUID();
  const idempotencyKey = 'gift-vault-scope-' + randomUUID();
  try {
    const installed = await client.query(
      `SELECT
         to_regclass('gift_address_vault_entries') IS NOT NULL AS vault_table,
         to_regclass('gift_address_vault_access_events') IS NOT NULL AS audit_table,
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'gift_address_vault_entry_scope_guard' AND NOT tgisinternal) AS scope_trigger,
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_purge_gift_address_vault' AND NOT tgisinternal) AS purge_trigger`
    );
    assert.equal(installed.rows[0].vault_table, true);
    assert.equal(installed.rows[0].audit_table, true);
    assert.equal(installed.rows[0].scope_trigger, true);
    assert.equal(installed.rows[0].purge_trigger, true);

    await client.query('BEGIN');
    try {
      await client.query(
        'INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, \'member\', \'active\', NOW()), ($3, $4, \'member\', \'active\', NOW())',
        [senderId, 'gift-vault-sender-' + senderId + '@example.invalid', recipientId, 'gift-vault-recipient-' + recipientId + '@example.invalid']
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
         VALUES ($1, $2, $3, $4, 'Vault scope test gift', 'chocolate',
            1500, 'USD', $5, 'delivered', 'captured',
            NOW() - INTERVAL '2 days', 1, $6,
            NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days',
            NOW() - INTERVAL '1 day', NOW() - INTERVAL '12 hours')`,
        [orderId, matchId, senderId, recipientId, idempotencyKey, vaultRef]
      );
      await client.query(
        `INSERT INTO gift_address_vault_entries
           (vault_ref, order_id, recipient_user_id, key_version, nonce, auth_tag, ciphertext)
         VALUES ($1, $2, $3, 'test-v1', $4, $5, $6)`,
        [vaultRef, orderId, recipientId, Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from('ciphertext-only')]
      );
      await client.query(
        `INSERT INTO gift_address_vault_access_events (order_id, actor_user_id, action)
         VALUES ($1, $2, 'created')`,
        [orderId, recipientId]
      );

      await client.query('SAVEPOINT before_wrong_recipient');
      await assert.rejects(
        client.query('UPDATE gift_address_vault_entries SET recipient_user_id = $1 WHERE order_id = $2', [senderId, orderId]),
        error => error.code === '23514',
        'vault entry must remain bound to the order recipient'
      );
      await client.query('ROLLBACK TO SAVEPOINT before_wrong_recipient');
      await client.query('RELEASE SAVEPOINT before_wrong_recipient');

      await client.query("UPDATE users SET status = 'deleted', updated_at = NOW() WHERE id = $1", [recipientId]);
      const [vault, order, audit] = await Promise.all([
        client.query('SELECT 1 FROM gift_address_vault_entries WHERE order_id = $1', [orderId]),
        client.query('SELECT status, payment_status, address_vault_ref FROM gift_delivery_orders WHERE id = $1', [orderId]),
        client.query('SELECT action FROM gift_address_vault_access_events WHERE order_id = $1', [orderId])
      ]);
      assert.equal(vault.rowCount, 0, 'encrypted address payload must be purged');
      assert.equal(order.rows[0].status, 'delivered');
      assert.equal(order.rows[0].payment_status, 'captured');
      assert.equal(order.rows[0].address_vault_ref, null, 'opaque order pointer must be revoked');
      assert.deepEqual(audit.rows.map(row => row.action), ['created'], 'PII-free access audit evidence is retained');
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
