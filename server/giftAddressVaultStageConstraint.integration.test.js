import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift address-vault pointer is restricted to post-verification order states', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'gift_orders_address_vault_requires_verified_stage'
         AND conrelid = 'gift_delivery_orders'::regclass`
    );
    assert.equal(constraint.rowCount, 1, 'migration 041 should install the verified-stage constraint');
    assert.equal(constraint.rows[0].convalidated, false, 'legacy rows remain explicitly subject to audit');
    assert.equal(typeof constraint.rows[0].definition, 'string', 'the installed production constraint must be inspectable');

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_address_vault_stage_test (
          status text NOT NULL,
          address_vault_ref text,
          recipient_consent_at timestamptz,
          recipient_consent_version smallint,
          address_verified_at timestamptz,
          CONSTRAINT gift_address_vault_stage_test_check ${constraint.rows[0].definition}
        ) ON COMMIT DROP
      `);
      await client.query(
        'INSERT INTO gift_address_vault_stage_test VALUES ($1, NULL, NULL, NULL, NULL)',
        ['awaiting_recipient_consent']
      );
      await client.query(
        'INSERT INTO gift_address_vault_stage_test VALUES ($1, $2, $3, $4, $5)',
        ['address_verified', 'vault:opaque-reference', '2026-10-28T00:00:00Z', 1, '2026-10-28T00:01:00Z']
      );

      const deniedCases = [
        ['awaiting_recipient_consent', 'vault:opaque-reference', '2026-10-28T00:00:00Z', 1, '2026-10-28T00:01:00Z'],
        ['recipient_accepted', 'vault:opaque-reference', '2026-10-28T00:00:00Z', 1, '2026-10-28T00:01:00Z'],
        ['declined', 'vault:opaque-reference', '2026-10-28T00:00:00Z', 1, '2026-10-28T00:01:00Z'],
        ['address_verified', 'vault:opaque-reference', null, 1, '2026-10-28T00:01:00Z'],
        ['address_verified', 'vault:opaque-reference', '2026-10-28T00:00:00Z', 0, '2026-10-28T00:01:00Z'],
        ['address_verified', 'vault:opaque-reference', '2026-10-28T00:00:00Z', 1, null]
      ];
      for (const values of deniedCases) {
        await client.query('SAVEPOINT invalid_vault_stage');
        let insertError;
        try {
          await client.query(
            'INSERT INTO gift_address_vault_stage_test (status, address_vault_ref, recipient_consent_at, recipient_consent_version, address_verified_at) VALUES ($1, $2, $3, $4, $5)',
            values
          );
        } catch (error) { insertError = error; }
        assert.equal(insertError?.code, '23514', 'must reject premature or incompletely verified address pointer');
        await client.query('ROLLBACK TO SAVEPOINT invalid_vault_stage');
        await client.query('RELEASE SAVEPOINT invalid_vault_stage');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  } finally {
    client.release();
    await pool.end();
  }
});
