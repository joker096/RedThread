import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift event metadata guard rejects sensitive keys recursively at the database boundary', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT 1
       FROM pg_constraint
       WHERE conname = 'gift_order_events_metadata_no_sensitive_keys'
         AND conrelid = 'gift_delivery_order_events'::regclass`
    );
    assert.equal(constraint.rowCount, 1, 'migration 026 should install the metadata constraint');

    const cases = [
      { value: { reason: 'account_deleted', source: 'moderation' }, expected: false, label: 'ordinary audit metadata' },
      { value: { Address: 'private' }, expected: true, label: 'case-insensitive address key' },
      { value: { context: { recipient_phone: '+995000000' } }, expected: true, label: 'nested phone key' },
      { value: { context: [{ safe: true }, { chatMessage: 'private text' }] }, expected: true, label: 'sensitive key in an array object' },
      { value: { address_vault_ref: 'opaque-reference' }, expected: true, label: 'address vault pointer key' },
      { value: { delivery_address: 'private' }, expected: true, label: 'delivery address alias' },
      { value: { shippingAddress: 'private' }, expected: true, label: 'shipping address alias' },
      { value: { recipient_full_name: 'private' }, expected: true, label: 'recipient full name alias' },
      { value: { contact_email: 'private@example.test' }, expected: true, label: 'contact email alias' },
      { value: { safe: [{ reason: 'consent_withdrawn' }] }, expected: false, label: 'safe nested audit values' }
    ];

    for (const item of cases) {
      const result = await client.query(
        'SELECT gift_event_metadata_has_forbidden_key($1::jsonb) AS forbidden',
        [JSON.stringify(item.value)]
      );
      assert.equal(result.rows[0].forbidden, item.expected, item.label);
    }

    // Exercise PostgreSQL CHECK enforcement itself, not only the helper function.
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_metadata_constraint_test (
          metadata jsonb NOT NULL,
          CONSTRAINT gift_metadata_constraint_test_no_sensitive_keys
            CHECK (NOT gift_event_metadata_has_forbidden_key(metadata))
        ) ON COMMIT DROP
      `);
      await client.query(
        'INSERT INTO gift_metadata_constraint_test (metadata) VALUES ($1::jsonb)',
        [JSON.stringify({ reason: 'account_deleted', context: { source: 'moderation' } })]
      );

      await client.query('SAVEPOINT forbidden_metadata_insert');
      let insertError;
      try {
        await client.query(
          'INSERT INTO gift_metadata_constraint_test (metadata) VALUES ($1::jsonb)',
          [JSON.stringify({ context: [{ delivery_address: 'private' }] })]
        );
      } catch (error) {
        insertError = error;
      }
      assert.equal(insertError?.code, '23514', 'CHECK constraint must reject a sensitive nested key');
      await client.query('ROLLBACK TO SAVEPOINT forbidden_metadata_insert');
      await client.query('RELEASE SAVEPOINT forbidden_metadata_insert');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
