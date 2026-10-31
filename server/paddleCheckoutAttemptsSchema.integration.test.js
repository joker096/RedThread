import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('Paddle checkout attempts enforce one durable attempt and fail-closed transaction states', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const table = await client.query(
      `SELECT to_regclass('public.paddle_checkout_attempts') AS table_name`
    );
    assert.equal(table.rows[0]?.table_name, 'paddle_checkout_attempts', 'migration 102 should create the checkout attempt table');

    const primaryKey = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'paddle_checkout_attempts_pkey'
         AND conrelid = 'paddle_checkout_attempts'::regclass`
    );
    assert.equal(primaryKey.rowCount, 1);
    assert.match(primaryKey.rows[0].definition, /PRIMARY KEY \(user_id\)/);

    const attemptIdentityColumn = await client.query(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'paddle_checkout_attempts'
         AND column_name = 'attempt_id'`
    );
    assert.equal(attemptIdentityColumn.rowCount, 1, 'migration 105 should add the immutable attempt identity');
    assert.equal(attemptIdentityColumn.rows[0].data_type, 'uuid');
    assert.equal(attemptIdentityColumn.rows[0].is_nullable, 'YES',
      'legacy attempts remain nullable and use exact transaction-ID matching');

    const attemptIdentityIndex = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'paddle_checkout_attempts'
         AND indexname = 'paddle_checkout_attempts_attempt_id_unique'`
    );
    assert.equal(attemptIdentityIndex.rowCount, 1);
    assert.match(attemptIdentityIndex.rows[0].indexdef, /UNIQUE INDEX/);
    assert.match(attemptIdentityIndex.rows[0].indexdef, /WHERE .*attempt_id IS NOT NULL/);


    const requiredTransaction = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'paddle_checkout_attempts_transaction_required_check'
         AND conrelid = 'paddle_checkout_attempts'::regclass`
    );
    assert.equal(requiredTransaction.rowCount, 1);
    const checkDefinition = requiredTransaction.rows[0].definition;

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE paddle_checkout_attempt_constraint_test (
          transaction_id text,
          status text,
          CONSTRAINT paddle_checkout_attempts_transaction_required_check
            ${checkDefinition}
        ) ON COMMIT DROP
      `);

      for (const status of ['creating', 'reconciliation_required']) {
        await client.query(
          'INSERT INTO paddle_checkout_attempt_constraint_test (transaction_id, status) VALUES (NULL, $1)',
          [status]
        );
      }

      for (const status of ['pending', 'completed', 'linked', 'canceled']) {
        await client.query('SAVEPOINT missing_transaction_id');
        let insertError;
        try {
          await client.query(
            'INSERT INTO paddle_checkout_attempt_constraint_test (transaction_id, status) VALUES (NULL, $1)',
            [status]
          );
        } catch (error) {
          insertError = error;
        }
        assert.equal(insertError?.code, '23514', `status ${status} must require a provider transaction ID`);
        await client.query('ROLLBACK TO SAVEPOINT missing_transaction_id');
        await client.query('RELEASE SAVEPOINT missing_transaction_id');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
