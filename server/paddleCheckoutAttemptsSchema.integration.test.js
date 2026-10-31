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

    const attemptIdentityTrigger = await client.query(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       WHERE t.tgrelid = 'paddle_checkout_attempts'::regclass
         AND t.tgname = 'paddle_checkout_attempts_identity_immutable'
         AND NOT t.tgisinternal`
    );
    assert.equal(attemptIdentityTrigger.rowCount, 1,
      'migration 106 must make the server-generated attempt identity immutable');
    assert.match(attemptIdentityTrigger.rows[0].definition, /BEFORE UPDATE OF attempt_id/);

    const attemptIdentityFunction = await client.query(
      `SELECT pg_get_functiondef('prevent_paddle_checkout_attempt_identity_change()'::regprocedure) AS definition`
    );
    assert.match(attemptIdentityFunction.rows[0].definition, /NEW\.attempt_id IS DISTINCT FROM OLD\.attempt_id/);
    assert.match(attemptIdentityFunction.rows[0].definition, /paddle checkout attempt identity is immutable/);

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE paddle_checkout_attempt_identity_test (
          attempt_id uuid
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER paddle_checkout_attempts_identity_immutable_test
        BEFORE UPDATE OF attempt_id ON paddle_checkout_attempt_identity_test
        FOR EACH ROW EXECUTE FUNCTION prevent_paddle_checkout_attempt_identity_change()
      `);
      await client.query(
        "INSERT INTO paddle_checkout_attempt_identity_test (attempt_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), (NULL)"
      );
      for (const [oldValue, newValue] of [
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
        [null, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null]
      ]) {
        await client.query('SAVEPOINT immutable_attempt_identity');
        let updateError;
        try {
          await client.query(
            'UPDATE paddle_checkout_attempt_identity_test SET attempt_id = $1 WHERE attempt_id IS NOT DISTINCT FROM $2::uuid',
            [newValue, oldValue]
          );
        } catch (error) {
          updateError = error;
        }
        assert.equal(updateError?.code, '23514',
          `attempt identity must reject mutation from ${String(oldValue)} to ${String(newValue)}`);
        await client.query('ROLLBACK TO SAVEPOINT immutable_attempt_identity');
        await client.query('RELEASE SAVEPOINT immutable_attempt_identity');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }


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
