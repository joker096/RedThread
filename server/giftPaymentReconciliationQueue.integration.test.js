import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift payment reconciliation outbox is installed with retryable states and an audit event', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT c.relname, pc.conname, pg_get_constraintdef(pc.oid) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_constraint pc ON pc.conrelid = c.oid
       WHERE n.nspname = current_schema()
         AND c.relname = 'gift_payment_reconciliation_tasks'
       ORDER BY pc.conname`
    );
    assert.ok(result.rowCount >= 1, 'migration 043 should create the reconciliation outbox');
    const definitions = result.rows.map(row => row.definition || '').join('\n');
    assert.match(definitions, /recipient_opted_out/, 'recipient opt-out reconciliation should be supported');
    assert.match(definitions, /safety_hold/, 'block, report, and account-safety transitions should queue reconciliation');
    assert.match(definitions, /expired_active_payment/, 'expired requests with unresolved payment must be reconcilable');
    assert.match(definitions, /pending/, 'tasks should support retryable pending work');
    assert.match(definitions, /completed_at/, 'completion timestamp must be constrained to completed tasks');

    const reasonConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_payment_reconciliation_tasks'::regclass
         AND conname = 'gift_payment_reconciliation_tasks_reason_check'`
    );
    assert.equal(reasonConstraint.rowCount, 1, 'migration 044 should install the reason constraint');
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_reconciliation_reason_constraint_test (
          reason text NOT NULL,
          CONSTRAINT gift_reconciliation_reason_constraint_test_check ${reasonConstraint.rows[0].definition}
        ) ON COMMIT DROP
      `);
      await client.query(
        "INSERT INTO gift_reconciliation_reason_constraint_test (reason) VALUES ('recipient_opted_out'), ('safety_hold'), ('expired_active_payment')"
      );
      await client.query('SAVEPOINT invalid_reconciliation_reason');
      let invalidReasonError;
      try {
        await client.query(
          "INSERT INTO gift_reconciliation_reason_constraint_test (reason) VALUES ('unsupported_reason')"
        );
      } catch (error) { invalidReasonError = error; }
      assert.equal(invalidReasonError?.code, '23514',
        'database must reject reconciliation reasons that are not explicitly supported');
      await client.query('ROLLBACK TO SAVEPOINT invalid_reconciliation_reason');
      await client.query('RELEASE SAVEPOINT invalid_reconciliation_reason');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const eventConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_order_events'::regclass
         AND conname = 'gift_delivery_order_events_event_type_check'`
    );
    assert.equal(eventConstraint.rowCount, 1);
    assert.match(eventConstraint.rows[0].definition, /payment_reconciliation_required/,
      'queued reconciliation must have a permitted audit event');

    const refundConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_orders'::regclass
         AND conname = 'gift_orders_refunded_status_payment_consistency'`
    );
    assert.equal(refundConstraint.rowCount, 1, 'migration 043 should enforce refund/order state consistency');
    assert.match(refundConstraint.rows[0].definition, /refunded/);

    await client.query('BEGIN');
    try {
      // Exercise the exact CHECK expression installed on the production table.
      await client.query(`
        CREATE TEMP TABLE gift_refund_state_constraint_test (
          status text NOT NULL,
          payment_status text NOT NULL,
          CONSTRAINT gift_refund_state_constraint_test_check ${refundConstraint.rows[0].definition}
        ) ON COMMIT DROP
      `);
      await client.query(
        `INSERT INTO gift_refund_state_constraint_test (status, payment_status)
         VALUES ('awaiting_recipient_consent', 'not_started'), ('refunded', 'refunded')`
      );
      for (const values of [
        ['cancelled', 'refunded'],
        ['expired', 'refunded'],
        ['refunded', 'captured']
      ]) {
        await client.query('SAVEPOINT invalid_refund_state');
        let insertError;
        try {
          await client.query(
            'INSERT INTO gift_refund_state_constraint_test (status, payment_status) VALUES ($1, $2)',
            values
          );
        } catch (error) { insertError = error; }
        assert.equal(insertError?.code, '23514', `database must reject mismatched refund state: ${values.join('/')}`);
        await client.query('ROLLBACK TO SAVEPOINT invalid_refund_state');
        await client.query('RELEASE SAVEPOINT invalid_refund_state');
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
