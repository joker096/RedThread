import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift address-vault pointer requires persisted versioned recipient consent', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT convalidated FROM pg_constraint
       WHERE conname = 'gift_orders_address_vault_requires_recipient_consent'
         AND conrelid = 'gift_delivery_orders'::regclass`
    );
    assert.equal(constraint.rowCount, 1, 'migration 040 should install the consent constraint');
    assert.equal(constraint.rows[0].convalidated, false, 'legacy rows remain explicitly subject to audit');
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_address_vault_consent_test (
          address_vault_ref text, recipient_consent_at timestamptz, recipient_consent_version smallint,
          CONSTRAINT gift_address_vault_consent_test_check CHECK (
            address_vault_ref IS NULL OR (recipient_consent_at IS NOT NULL AND recipient_consent_version IS NOT NULL AND recipient_consent_version > 0)
          )
        ) ON COMMIT DROP
      `);
      await client.query('INSERT INTO gift_address_vault_consent_test VALUES (NULL, NULL, NULL)');
      await client.query('INSERT INTO gift_address_vault_consent_test VALUES ($1, $2, $3)', ['vault:opaque-reference', '2026-10-28T00:00:00Z', 1]);
      const deniedCases = [
        ['vault:opaque-reference', null, null],
        ['vault:opaque-reference', '2026-10-28T00:00:00Z', null],
        ['vault:opaque-reference', '2026-10-28T00:00:00Z', 0],
        ['vault:opaque-reference', null, 1]
      ];
      for (const values of deniedCases) {
        await client.query('SAVEPOINT invalid_vault_reference');
        let insertError;
        try {
          await client.query('INSERT INTO gift_address_vault_consent_test VALUES ($1, $2, $3)', values);
        } catch (error) { insertError = error; }
        assert.equal(insertError?.code, '23514', 'must reject invalid vault reference consent tuple');
        await client.query('ROLLBACK TO SAVEPOINT invalid_vault_reference');
        await client.query('RELEASE SAVEPOINT invalid_vault_reference');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  } finally { client.release(); await pool.end(); }
});
