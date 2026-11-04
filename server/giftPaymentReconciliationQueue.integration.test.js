import test from 'node:test';
import { randomUUID } from 'node:crypto';
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
    const expiryIndex = await client.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'gift_delivery_orders'
         AND indexname = 'gift_orders_expired_consent_candidates_idx'`
    );
    assert.equal(expiryIndex.rowCount, 1, 'migration 046 should index scheduled expiry candidate discovery');
    assert.match(expiryIndex.rows[0].indexdef, /\(expires_at, match_id, sender_id, recipient_id\)/i);
    assert.match(expiryIndex.rows[0].indexdef, /WHERE \(status = 'awaiting_recipient_consent'::text\)/i);

    const oneTaskIndex = await client.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'gift_payment_reconciliation_tasks'
         AND indexname = 'gift_payment_reconciliation_one_task_per_order_idx'`
    );
    assert.equal(oneTaskIndex.rowCount, 1,
      'migration 112 must enforce exactly one reconciliation task per gift order');
    assert.match(oneTaskIndex.rows[0].indexdef, /UNIQUE INDEX/i);
    assert.match(oneTaskIndex.rows[0].indexdef, /\(order_id\)/i);

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_reconciliation_one_task_test
        (LIKE gift_payment_reconciliation_tasks INCLUDING ALL)
        ON COMMIT DROP
      `);
      const testOrderId = '00000000-0000-4000-8000-000000000001';
      await client.query(
        `INSERT INTO gift_reconciliation_one_task_test (order_id, reason)
         VALUES ($1, 'recipient_declined_active_payment')`, [testOrderId]
      );
      let duplicateTaskError;
      try {
        await client.query(
          `INSERT INTO gift_reconciliation_one_task_test (order_id, reason)
           VALUES ($1, 'recipient_opted_out')`, [testOrderId]
        );
      } catch (error) { duplicateTaskError = error; }
      assert.equal(duplicateTaskError?.code, '23505',
        'multiple trigger reasons must not create duplicate provider work for one order');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const definitions = result.rows.map(row => row.definition || '').join('\n');
    assert.match(definitions, /recipient_opted_out/, 'recipient opt-out reconciliation should be supported');
    assert.match(definitions, /safety_hold/, 'block, report, and account-safety transitions should queue reconciliation');
    assert.match(definitions, /expired_active_payment/, 'expired requests with unresolved payment must be reconcilable');
    assert.match(definitions, /recipient_declined_active_payment/, 'recipient declines with unresolved payment must be durably recorded');
    assert.match(definitions, /pending/, 'tasks should support retryable pending work');
    assert.match(definitions, /completed_at/, 'completion timestamp must be constrained to completed tasks');

    const reasonConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_payment_reconciliation_tasks'::regclass
         AND conname = 'gift_payment_reconciliation_tasks_reason_check'`
    );
    assert.equal(reasonConstraint.rowCount, 1, 'migration 111 should install the final reason constraint');
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_reconciliation_reason_constraint_test (
          reason text NOT NULL,
          CONSTRAINT gift_reconciliation_reason_constraint_test_check ${reasonConstraint.rows[0].definition}
        ) ON COMMIT DROP
      `);
      await client.query(
        "INSERT INTO gift_reconciliation_reason_constraint_test (reason) VALUES ('recipient_opted_out'), ('safety_hold'), ('expired_active_payment'), ('recipient_declined_active_payment')"
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


test('gift reconciliation task completion requires a same-transaction provider outcome and immutable event', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const matchId = randomUUID();
  const orderId = randomUUID();
  const idempotencyKey = 'gift-reconciliation-evidence-' + randomUUID();
  try {
    for (const [id, suffix] of [[senderId, 'sender'], [recipientId, 'recipient']]) {
      await client.query(
        'INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, \'member\', \'active\', NOW())',
        [id, 'gift-reconciliation-' + suffix + '-' + randomUUID() + '@example.invalid']
      );
    }
    await client.query(
      'INSERT INTO matches (id, user_a_id, user_b_id, status, created_at) ' +
      'VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), \'active\', NOW())',
      [matchId, senderId, recipientId]
    );
    await client.query(
      'INSERT INTO gift_delivery_orders ' +
      '(id, match_id, sender_id, recipient_id, product_name_snapshot, product_category, ' +
      'total_minor_units, currency, idempotency_key, status, payment_status) ' +
      'VALUES ($1, $2, $3, $4, \'Reconciliation test gift\', \'chocolate\', 1500, \'USD\', $5, ' +
      '\'awaiting_recipient_consent\', \'authorized\')',
      [orderId, matchId, senderId, recipientId, idempotencyKey]
    );
    const task = await client.query(
      'INSERT INTO gift_payment_reconciliation_tasks (order_id, reason) ' +
      'VALUES ($1, \'recipient_opted_out\') RETURNING id',
      [orderId]
    );
    const taskId = task.rows[0].id;

    await client.query('BEGIN');
    await client.query(
      'UPDATE gift_payment_reconciliation_tasks ' +
      'SET status = \'in_progress\', attempt_count = attempt_count + 1 WHERE id = $1',
      [taskId]
    );
    await client.query(
      'UPDATE gift_payment_reconciliation_tasks SET status = \'completed\' WHERE id = $1',
      [taskId]
    );
    await assert.rejects(
      client.query('COMMIT'),
      error => error.code === '23514',
      'a task must not complete while its order still has an active payment and no provider event'
    );
    await client.query('ROLLBACK').catch(() => {});

    const unchanged = await client.query(
      'SELECT status, attempt_count, completed_at FROM gift_payment_reconciliation_tasks WHERE id = $1',
      [taskId]
    );
    assert.equal(unchanged.rows[0].status, 'pending');
    assert.equal(unchanged.rows[0].attempt_count, 0);
    assert.equal(unchanged.rows[0].completed_at, null);

    await client.query('BEGIN');
    await client.query(
      'UPDATE gift_delivery_orders SET payment_status = \'voided\', updated_at = statement_timestamp() WHERE id = $1',
      [orderId]
    );
    await client.query(
      'INSERT INTO gift_delivery_order_events ' +
      '(order_id, actor_type, event_type, from_status, to_status, metadata) ' +
      'VALUES ($1, \'payment_service\', \'payment_voided\', ' +
      '\'awaiting_recipient_consent\', \'awaiting_recipient_consent\', ' +
      'jsonb_build_object(\'reconciliationTaskId\', $2::text, \'provider\', \'test_provider\', ' +
      '\'providerReference\', \'test-payment-ref-\' || $2::text, ' +
      '\'fromPaymentStatus\', \'authorized\', \'toPaymentStatus\', \'voided\'))',
      [orderId, taskId]
    );
    await client.query(
      'UPDATE gift_payment_reconciliation_tasks ' +
      'SET status = \'in_progress\', attempt_count = attempt_count + 1 WHERE id = $1',
      [taskId]
    );
    await client.query(
      'UPDATE gift_payment_reconciliation_tasks SET status = \'completed\' WHERE id = $1',
      [taskId]
    );
    await client.query('COMMIT');

    const completed = await client.query(
      'SELECT status, attempt_count, completed_at FROM gift_payment_reconciliation_tasks WHERE id = $1',
      [taskId]
    );
    assert.equal(completed.rows[0].status, 'completed');
    assert.equal(completed.rows[0].attempt_count, 1);
    assert.ok(completed.rows[0].completed_at);

    const transactionEvidence = await client.query(
      'SELECT gift_order.payment_state_changed_transaction_id::text AS order_tx, ' +
      'event.created_transaction_id::text AS event_tx ' +
      'FROM gift_delivery_orders AS gift_order ' +
      'JOIN gift_delivery_order_events AS event ON event.order_id = gift_order.id ' +
      'WHERE gift_order.id = $1 AND event.metadata->>\'reconciliationTaskId\' = $2::text',
      [orderId, taskId]
    );
    assert.equal(transactionEvidence.rowCount, 1);
    assert.equal(transactionEvidence.rows[0].order_tx, transactionEvidence.rows[0].event_tx,
      'the provider outcome and order payment transition must share the exact database transaction');

    const originalTransactionMarker = transactionEvidence.rows[0].order_tx;
    await client.query(
      'UPDATE gift_delivery_orders SET payment_state_changed_transaction_id = NULL WHERE id = $1',
      [orderId]
    );
    const protectedMarker = await client.query(
      'SELECT payment_state_changed_transaction_id::text AS tx FROM gift_delivery_orders WHERE id = $1',
      [orderId]
    );
    assert.equal(protectedMarker.rows[0].tx, originalTransactionMarker,
      'callers must not forge or clear the payment-state transaction marker');

    await assert.rejects(
      client.query(
        'UPDATE gift_payment_reconciliation_tasks SET status = \'pending\' WHERE id = $1',
        [taskId]
      ),
      error => error.code === '55000',
      'completed financial reconciliation evidence must be immutable'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
