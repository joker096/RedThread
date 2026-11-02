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
    const productionTriggerDefinition = attemptIdentityTrigger.rows[0].definition;
    assert.match(productionTriggerDefinition, /BEFORE UPDATE OF/);
    for (const column of ['attempt_id', 'user_id', 'status', 'transaction_id', 'plan']) {
      assert.ok(productionTriggerDefinition.includes(column),
        `the production trigger must guard updates to ${column}`);
    }

    const attemptIdentityFunction = await client.query(
      `SELECT pg_get_functiondef('prevent_paddle_checkout_attempt_identity_change()'::regprocedure) AS definition`
    );
    assert.match(attemptIdentityFunction.rows[0].definition, /NEW\.attempt_id IS DISTINCT FROM OLD\.attempt_id/);
    assert.match(attemptIdentityFunction.rows[0].definition, /paddle checkout attempt identity is immutable/);
    assert.match(attemptIdentityFunction.rows[0].definition, /terminal_rollover := OLD\.status IN/,
      'terminal rollover must require a fresh attempt identity');
    assert.match(attemptIdentityFunction.rows[0].definition, /paddle checkout transaction identity is immutable/);
    assert.match(attemptIdentityFunction.rows[0].definition, /IF NEW\.user_id IS DISTINCT FROM OLD\.user_id THEN/,
      'account ownership changes must be rejected even without rotating attempt_id');

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE paddle_checkout_attempt_identity_test (
          user_id uuid NOT NULL,
          attempt_id uuid,
          status text NOT NULL,
          transaction_id text,
          plan text NOT NULL DEFAULT '1month'
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER paddle_checkout_attempts_identity_immutable_test
        BEFORE UPDATE OF attempt_id, user_id, status, transaction_id, plan ON paddle_checkout_attempt_identity_test
        FOR EACH ROW EXECUTE FUNCTION prevent_paddle_checkout_attempt_identity_change()
      `);
      await client.query(
        `INSERT INTO paddle_checkout_attempt_identity_test (user_id, attempt_id, status, transaction_id)
         VALUES
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pending', 'txn_active123'),
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, 'creating', NULL),
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'canceled', 'txn_canceled123'),
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'linked', 'txn_linked123')`
      );
      const rejectedChanges = [
        {
          oldId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          newId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          status: 'creating', transactionId: null,
          reason: 'an active pending attempt cannot be replaced'
        },
        {
          oldId: null,
          newId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          status: 'creating', transactionId: null,
          reason: 'a legacy creating attempt cannot acquire a retroactive identity'
        },
        {
          oldId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          newId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          status: 'pending', transactionId: null,
          reason: 'a terminal row cannot be rotated directly into a pending attempt'
        },
        {
          oldId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          newId: '11111111-1111-4111-8111-111111111111',
          status: 'creating', transactionId: 'txn_linked123',
          reason: 'terminal rollover must clear the previous transaction ID'
        }
      ];
      for (const change of rejectedChanges) {
        await client.query('SAVEPOINT immutable_attempt_identity');
        let updateError;
        try {
          await client.query(
            `UPDATE paddle_checkout_attempt_identity_test
             SET attempt_id = $1, status = $3, transaction_id = $4
             WHERE attempt_id IS NOT DISTINCT FROM $2::uuid`,
            [change.newId, change.oldId, change.status, change.transactionId]
          );
        } catch (error) {
          updateError = error;
        }
        assert.equal(updateError?.code, '23514', change.reason);
        await client.query('ROLLBACK TO SAVEPOINT immutable_attempt_identity');
        await client.query('RELEASE SAVEPOINT immutable_attempt_identity');
      }

      await client.query('SAVEPOINT allow_terminal_plan_rollover');
      await client.query(
        `UPDATE paddle_checkout_attempt_identity_test
         SET attempt_id = $1, status = 'creating', transaction_id = NULL, plan = '3months'
         WHERE attempt_id = $2::uuid`,
        ['22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
      );
      const terminalRolloverPlan = await client.query(
        `SELECT plan, status FROM paddle_checkout_attempt_identity_test
         WHERE attempt_id = '22222222-2222-4222-8222-222222222222'`
      );
      assert.deepEqual(terminalRolloverPlan.rows[0], { plan: '3months', status: 'creating' },
        'a fresh terminal rollover may intentionally select a different plan');
      await client.query('ROLLBACK TO SAVEPOINT allow_terminal_plan_rollover');
      await client.query('RELEASE SAVEPOINT allow_terminal_plan_rollover');

      await client.query('SAVEPOINT reject_completed_downgrade');
      await client.query(
        `UPDATE paddle_checkout_attempt_identity_test SET status = 'completed'
         WHERE attempt_id = $1::uuid`,
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
      );
      let completedDowngradeError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test SET status = 'canceled'
           WHERE attempt_id = $1::uuid`,
          ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
        );
      } catch (error) {
        completedDowngradeError = error;
      }
      assert.equal(completedDowngradeError?.code, '23514',
        'a completed payment must not be downgraded to canceled');
      await client.query('ROLLBACK TO SAVEPOINT reject_completed_downgrade');
      await client.query('RELEASE SAVEPOINT reject_completed_downgrade');

      await client.query('SAVEPOINT reject_direct_link');
      let directLinkError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test SET status = 'linked'
           WHERE status = 'creating' AND attempt_id IS NULL`
        );
      } catch (error) {
        directLinkError = error;
      }
      assert.equal(directLinkError?.code, '23514',
        'an attempt must pass through completed before it can become linked');
      await client.query('ROLLBACK TO SAVEPOINT reject_direct_link');
      await client.query('RELEASE SAVEPOINT reject_direct_link');

      await client.query('SAVEPOINT reject_terminal_identity_reuse');
      let terminalIdentityReuseError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test
           SET status = 'creating', transaction_id = NULL
           WHERE attempt_id = $1::uuid`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
        );
      } catch (error) {
        terminalIdentityReuseError = error;
      }
      assert.equal(terminalIdentityReuseError?.code, '23514',
        'a terminal attempt must not be reactivated with its old attempt_id');
      await client.query('ROLLBACK TO SAVEPOINT reject_terminal_identity_reuse');
      await client.query('RELEASE SAVEPOINT reject_terminal_identity_reuse');

      await client.query('SAVEPOINT reject_active_plan_swap');
      let activePlanSwapError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test SET plan = '3months'
           WHERE attempt_id = $1::uuid`,
          ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
        );
      } catch (error) {
        activePlanSwapError = error;
      }
      assert.equal(activePlanSwapError?.code, '23514',
        'an active checkout attempt plan must not be changed');
      await client.query('ROLLBACK TO SAVEPOINT reject_active_plan_swap');
      await client.query('RELEASE SAVEPOINT reject_active_plan_swap');

      await client.query('SAVEPOINT reject_active_transaction_swap');
      let transactionSwapError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test SET transaction_id = $1
           WHERE attempt_id = $2::uuid`,
          ['txn_replacement123', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
        );
      } catch (error) {
        transactionSwapError = error;
      }
      assert.equal(transactionSwapError?.code, '23514',
        'an attached provider transaction ID must not be replaced');
      await client.query('ROLLBACK TO SAVEPOINT reject_active_transaction_swap');
      await client.query('RELEASE SAVEPOINT reject_active_transaction_swap');

      await client.query('SAVEPOINT reject_attempt_owner_transfer');
      let ownerTransferError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test
           SET user_id = $1, attempt_id = $2, status = 'creating', transaction_id = NULL
           WHERE attempt_id = $3::uuid`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '44444444-4444-4444-8444-444444444444', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
        );
      } catch (error) {
        ownerTransferError = error;
      }
      assert.equal(ownerTransferError?.code, '23514',
        'terminal rollover must not transfer a checkout attempt to another account');
      await client.query('ROLLBACK TO SAVEPOINT reject_attempt_owner_transfer');
      await client.query('RELEASE SAVEPOINT reject_attempt_owner_transfer');

      await client.query('SAVEPOINT reject_owner_only_change');
      let ownerOnlyError;
      try {
        await client.query(
          `UPDATE paddle_checkout_attempt_identity_test SET user_id = $1
           WHERE attempt_id = $2::uuid`,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
        );
      } catch (error) {
        ownerOnlyError = error;
      }
      assert.equal(ownerOnlyError?.code, '23514',
        'account ownership must remain immutable even when attempt_id is unchanged');
      await client.query('ROLLBACK TO SAVEPOINT reject_owner_only_change');
      await client.query('RELEASE SAVEPOINT reject_owner_only_change');
      for (const [oldId, newId] of [
        ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222'],
        ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333']
      ]) {
        const result = await client.query(
          `UPDATE paddle_checkout_attempt_identity_test
           SET attempt_id = $1, status = 'creating', transaction_id = NULL
           WHERE attempt_id = $2::uuid AND status IN ('canceled', 'linked')`,
          [newId, oldId]
        );
        assert.equal(result.rowCount, 1,
          'a new immutable identity may be allocated only when the previous attempt is terminal and the row is reset to creating');
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

      for (const status of ['creating', 'reconciliation_required', 'canceled']) {
        await client.query(
          'INSERT INTO paddle_checkout_attempt_constraint_test (transaction_id, status) VALUES (NULL, $1)',
          [status]
        );
      }

      for (const status of ['pending', 'completed', 'linked']) {
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
