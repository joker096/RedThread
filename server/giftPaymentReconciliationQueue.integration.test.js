import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift payment reconciliation outbox is installed with retryable states and an audit event', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
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
    assert.match(definitions, /recipient_opted_out/, 'only supported reconciliation reasons should be accepted');
    assert.match(definitions, /pending/, 'tasks should support retryable pending work');
    assert.match(definitions, /completed_at/, 'completion timestamp must be constrained to completed tasks');

    const eventConstraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_order_events'::regclass
         AND conname = 'gift_delivery_order_events_event_type_check'`
    );
    assert.equal(eventConstraint.rowCount, 1);
    assert.match(eventConstraint.rows[0].definition, /payment_reconciliation_required/,
      'queued reconciliation must have a permitted audit event');

    const refundConstraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_orders'::regclass
         AND conname = 'gift_orders_refunded_status_payment_consistency'`
    );
    assert.equal(refundConstraint.rowCount, 1, 'migration 043 should enforce refund/order state consistency');
    assert.match(refundConstraint.rows[0].definition, /refunded/);
  } finally {
    await pool.end();
  }
});
