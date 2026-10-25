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
    assert.equal(constraint.rowCount, 1, 'migration 028 should install the withdrawn-consent constraint');
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

      // A withdrawn request may remain in a safe terminal state. Payment
      // reconciliation is separate, so the database rule must not rewrite it.
      await client.query(
        `INSERT INTO gift_withdrawn_consent_constraint_test
          (status, consent_withdrawn_at, payment_status)
         VALUES ('cancelled', $1, 'authorization_pending')`,
        ['2026-10-25T10:00:00Z']
      );
      const preserved = await client.query(
        `SELECT status, payment_status
         FROM gift_withdrawn_consent_constraint_test
         WHERE status = 'cancelled'`
      );
      assert.deepEqual(preserved.rows, [{ status: 'cancelled', payment_status: 'authorization_pending' }]);

      // Without a withdrawal timestamp, ordinary eligible states are not
      // blocked by this specific constraint.
      await client.query(
        `INSERT INTO gift_withdrawn_consent_constraint_test
          (status, consent_withdrawn_at, payment_status)
         VALUES ('recipient_accepted', NULL, 'authorized')`
      );

      for (const status of [
        'recipient_accepted', 'address_verified', 'fulfilment_authorized',
        'dispatched', 'delivered', 'delivery_failed'
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
