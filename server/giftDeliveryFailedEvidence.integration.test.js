import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('delivery_failed gift orders require persisted consent, address and fulfilment evidence', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraints = await client.query(
      `SELECT conname
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_orders'::regclass
         AND conname = ANY($1::text[])`,
      [[
        'gift_orders_delivery_failed_consent_required',
        'gift_orders_delivery_failed_address_required',
        'gift_orders_delivery_failed_fulfilment_payment_required'
      ]]
    );
    assert.deepEqual(
      constraints.rows.map((row) => row.conname).sort(),
      [
        'gift_orders_delivery_failed_address_required',
        'gift_orders_delivery_failed_consent_required',
        'gift_orders_delivery_failed_fulfilment_payment_required'
      ],
      'migration 027 should install all delivery_failed evidence constraints'
    );

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE gift_delivery_failed_constraint_test
        (LIKE gift_delivery_orders INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
        ON COMMIT DROP
      `);

      const base = {
        match_id: '00000000-0000-4000-8000-000000000001',
        sender_id: '00000000-0000-4000-8000-000000000002',
        recipient_id: '00000000-0000-4000-8000-000000000003',
        product_name_snapshot: 'Reviewed gift',
        product_category: 'chocolate',
        total_minor_units: 2500,
        currency: 'GEL',
        status: 'delivery_failed',
        payment_status: 'authorized',
        idempotency_key: 'delivery-failed-test-0001'
      };
      const columns = Object.keys(base);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      let insertError;
      try {
        await client.query(
          `INSERT INTO gift_delivery_failed_constraint_test (${columns.join(', ')})
           VALUES (${placeholders})`,
          columns.map((column) => base[column])
        );
      } catch (error) {
        insertError = error;
      }
      assert.equal(insertError?.code, '23514', 'database CHECK constraints must reject missing delivery_failed evidence');

      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
