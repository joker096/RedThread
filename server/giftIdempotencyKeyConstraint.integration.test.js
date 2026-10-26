import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift idempotency keys are non-empty and normalized at the database boundary', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'gift_orders_idempotency_key_normalized'
         AND conrelid = 'gift_delivery_orders'::regclass`
    );
    assert.equal(constraint.rowCount, 1, 'migration 031 should install the idempotency-key constraint');
    const constraintDefinition = constraint.rows[0]?.definition;
    assert.equal(typeof constraintDefinition, 'string', 'PostgreSQL should expose the installed constraint definition');

    await client.query('BEGIN');
    try {
      // Exercise the exact CHECK expression installed on the production table,
      // rather than maintaining a second copy of the policy in this test.
      await client.query(`
        CREATE TEMP TABLE gift_idempotency_key_constraint_test (
          idempotency_key varchar(128) NOT NULL,
          CONSTRAINT gift_orders_idempotency_key_normalized
            ${constraintDefinition}
        ) ON COMMIT DROP
      `);

      for (const validKey of ['req_01HXYZ', '550e8400-e29b-41d4-a716-446655440000']) {
        await client.query(
          'INSERT INTO gift_idempotency_key_constraint_test (idempotency_key) VALUES ($1)',
          [validKey]
        );
      }

      for (const invalidKey of ['', '   ', ' leading', 'trailing ', ' both ']) {
        await client.query('SAVEPOINT invalid_idempotency_key');
        let insertError;
        try {
          await client.query(
            'INSERT INTO gift_idempotency_key_constraint_test (idempotency_key) VALUES ($1)',
            [invalidKey]
          );
        } catch (error) {
          insertError = error;
        }
        assert.equal(insertError?.code, '23514', `installed CHECK constraint must reject malformed idempotency key: ${JSON.stringify(invalidKey)}`);
        await client.query('ROLLBACK TO SAVEPOINT invalid_idempotency_key');
        await client.query('RELEASE SAVEPOINT invalid_idempotency_key');
      }
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
