import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('withdrawn gift consent blocks fulfilment progression at the database boundary', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_orders'::regclass
         AND conname = 'gift_orders_withdrawn_consent_cannot_progress'`
    );
    assert.equal(constraint.rowCount, 1, 'migration 030 should install the withdrawn-consent constraint');
    const constraintDefinition = constraint.rows[0]?.definition;
    assert.equal(typeof constraintDefinition, 'string', 'PostgreSQL should expose the installed constraint definition');

    await client.query('BEGIN');
    try {
      // Exercise the exact CHECK expression installed on the production table,
      // not a separately maintained copy of the policy.
      await client.query(`
        CREATE TEMP TABLE gift_withdrawn_consent_constraint_test (
          status text NOT NULL,
          consent_withdrawn_at timestamptz,
          payment_status text NOT NULL,
          CONSTRAINT gift_orders_withdrawn_consent_cannot_progress
            ${constraintDefinition}
        ) ON COMMIT DROP
      `);

      // A withdrawn request may remain in a safe terminal state. Use a payment
      // state accepted by the full production schema's terminal-state constraints.
      await client.query(
        `INSERT INTO gift_withdrawn_consent_constraint_test
          (status, consent_withdrawn_at, payment_status)
         VALUES ('cancelled', $1, 'voided')`,
        ['2026-10-25T10:00:00Z']
      );
      const preserved = await client.query(
        `SELECT status, payment_status
         FROM gift_withdrawn_consent_constraint_test
         WHERE status = 'cancelled'`
      );
      assert.deepEqual(preserved.rows, [{ status: 'cancelled', payment_status: 'voided' }]);

      // Reopening an already-cancelled order must fail on UPDATE as well as
      // INSERT; this is the concrete stale-consent regression the migration guards.
      await client.query('SAVEPOINT withdrawn_consent_reopen');
      let reopenError;
      try {
        await client.query("UPDATE gift_withdrawn_consent_constraint_test SET status = 'awaiting_recipient_consent' WHERE status = 'cancelled'");
      } catch (error) {
        reopenError = error;
      }
      assert.equal(reopenError?.code, '23514', 'a withdrawn order must not return to the recipient-consent queue');
      await client.query('ROLLBACK TO SAVEPOINT withdrawn_consent_reopen');
      await client.query('RELEASE SAVEPOINT withdrawn_consent_reopen');

      // Without a withdrawal timestamp, ordinary eligible states are not
      // blocked by this specific constraint.
      await client.query(
        `INSERT INTO gift_withdrawn_consent_constraint_test
          (status, consent_withdrawn_at, payment_status)
         VALUES ('recipient_accepted', NULL, 'authorized')`
      );

      for (const status of [
        'awaiting_recipient_consent', 'recipient_accepted', 'address_verified',
        'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'
      ]) {
        await client.query('SAVEPOINT withdrawn_consent_insert');
        let insertError;
        try {
          await client.query(
            `INSERT INTO gift_withdrawn_consent_constraint_test
              (status, consent_withdrawn_at, payment_status)
             VALUES ($1, $2, $3)`,
            [status, '2026-10-25T10:00:00Z', 'authorized']
          );
        } catch (error) {
          insertError = error;
        }
        assert.equal(insertError?.code, '23514', `withdrawn consent must reject status: ${status}`);
        await client.query('ROLLBACK TO SAVEPOINT withdrawn_consent_insert');
        await client.query('RELEASE SAVEPOINT withdrawn_consent_insert');
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

test('gift consent withdrawal timestamp is immutable without rewriting payment state', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const installedTrigger = await client.query(
      `SELECT t.tgname, p.proname, pg_get_functiondef(p.oid) AS definition
       FROM pg_trigger t
       JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'gift_delivery_orders'::regclass
         AND t.tgname = 'gift_orders_consent_withdrawal_immutable'
         AND NOT t.tgisinternal`
    );
    assert.equal(installedTrigger.rowCount, 1, 'migration 029 should install the immutable-withdrawal trigger');
    assert.equal(installedTrigger.rows[0].proname, 'prevent_gift_consent_withdrawal_reversal');
    assert.match(installedTrigger.rows[0].definition, /gift consent withdrawal timestamp is immutable/);

    await client.query('BEGIN');
    try {
      // Attach the installed production trigger function to an isolated table,
      // so its actual PL/pgSQL behavior can be exercised without mutating a real order.
      await client.query(`
        CREATE TEMP TABLE gift_withdrawal_immutable_test (
          id integer PRIMARY KEY,
          status text NOT NULL,
          consent_withdrawn_at timestamptz,
          payment_status text NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER gift_withdrawal_immutable_test_trigger
        BEFORE UPDATE OF consent_withdrawn_at ON gift_withdrawal_immutable_test
        FOR EACH ROW EXECUTE FUNCTION prevent_gift_consent_withdrawal_reversal()
      `);

      // First recording a withdrawal is allowed.
      await client.query(
        `INSERT INTO gift_withdrawal_immutable_test
          (id, status, consent_withdrawn_at, payment_status)
         VALUES (1, 'cancelled', NULL, 'authorization_pending')`
      );
      await client.query(
        `UPDATE gift_withdrawal_immutable_test
         SET consent_withdrawn_at = $1 WHERE id = 1`,
        ['2026-10-25T10:00:00Z']
      );

      for (const replacement of [null, '2026-10-25T11:00:00Z']) {
        await client.query('SAVEPOINT immutable_withdrawal_attempt');
        let updateError;
        try {
          await client.query(
            `UPDATE gift_withdrawal_immutable_test
             SET consent_withdrawn_at = $1 WHERE id = 1`,
            [replacement]
          );
        } catch (error) {
          updateError = error;
        }
        assert.equal(updateError?.code, '23514', `withdrawal timestamp mutation must be rejected: ${replacement}`);
        await client.query('ROLLBACK TO SAVEPOINT immutable_withdrawal_attempt');
        await client.query('RELEASE SAVEPOINT immutable_withdrawal_attempt');
      }

      // Reapplying the same timestamp and changing an unrelated payment field
      // remain valid; the trigger must not silently rewrite payment state.
      await client.query(
        `UPDATE gift_withdrawal_immutable_test
         SET consent_withdrawn_at = $1 WHERE id = 1`,
        ['2026-10-25T10:00:00Z']
      );
      const unchanged = await client.query(
        `SELECT consent_withdrawn_at, payment_status
         FROM gift_withdrawal_immutable_test WHERE id = 1`
      );
      assert.equal(new Date(unchanged.rows[0].consent_withdrawn_at).toISOString(), '2026-10-25T10:00:00.000Z');
      assert.equal(unchanged.rows[0].payment_status, 'authorization_pending');

      await client.query(
        `UPDATE gift_withdrawal_immutable_test
         SET payment_status = 'authorization_pending' WHERE id = 1`
      );
      const payment = await client.query(
        `SELECT consent_withdrawn_at, payment_status
         FROM gift_withdrawal_immutable_test WHERE id = 1`
      );
      assert.equal(new Date(payment.rows[0].consent_withdrawn_at).toISOString(), '2026-10-25T10:00:00.000Z');
      assert.equal(payment.rows[0].payment_status, 'authorization_pending');

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

test('consent withdrawal audit event is allowed by the installed database constraint', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_order_events'::regclass
         AND conname = 'gift_delivery_order_events_event_type_check'`
    );
    assert.equal(result.rowCount, 1, 'migration 032 should install the gift event type constraint');
    const definition = result.rows[0]?.definition;
    assert.equal(typeof definition, 'string', 'PostgreSQL should expose the installed event type constraint');
    assert.match(definition, /consent_withdrawn/, 'withdrawal audit events must be accepted by the production constraint');

    await client.query('BEGIN');
    try {
      // Reuse the actual production CHECK definition so this regression test
      // fails if a later migration accidentally removes consent_withdrawn.
      await client.query(`
        CREATE TEMP TABLE gift_withdrawal_event_type_test (
          event_type text NOT NULL,
          CONSTRAINT gift_withdrawal_event_type_test_check ${definition}
        ) ON COMMIT DROP
      `);
      await client.query(
        `INSERT INTO gift_withdrawal_event_type_test (event_type)
         VALUES ('consent_withdrawn')`
      );
      await client.query('SAVEPOINT unknown_event_type');
      let invalidEventError;
      try {
        await client.query(
          `INSERT INTO gift_withdrawal_event_type_test (event_type)
           VALUES ('consent_withdrawal_typo')`
        );
      } catch (error) {
        invalidEventError = error;
      }
      assert.equal(invalidEventError?.code, '23514', 'unknown event types must remain rejected');
      await client.query('ROLLBACK TO SAVEPOINT unknown_event_type');
      await client.query('RELEASE SAVEPOINT unknown_event_type');
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
