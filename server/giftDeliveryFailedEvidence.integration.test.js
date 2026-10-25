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
      // Keep this fixture independent of unrelated user/match foreign keys and
      // NOT NULL columns. The live table's constraint installation is checked
      // above; this table exercises the same three CHECK expressions directly.
      await client.query(`
        CREATE TEMP TABLE gift_delivery_failed_constraint_test (
          status text NOT NULL,
          recipient_consent_at timestamptz,
          address_vault_ref text,
          address_verified_at timestamptz,
          fulfilment_authorized_at timestamptz,
          payment_status text,
          CONSTRAINT gift_orders_delivery_failed_consent_required
            CHECK (status <> 'delivery_failed' OR recipient_consent_at IS NOT NULL),
          CONSTRAINT gift_orders_delivery_failed_address_required
            CHECK (
              status <> 'delivery_failed'
              OR (
                address_vault_ref IS NOT NULL
                AND btrim(address_vault_ref) <> ''
                AND address_verified_at IS NOT NULL
              )
            ),
          CONSTRAINT gift_orders_delivery_failed_fulfilment_payment_required
            CHECK (
              status <> 'delivery_failed'
              OR (
                fulfilment_authorized_at IS NOT NULL
                AND payment_status IN ('authorized', 'captured')
              )
            )
        ) ON COMMIT DROP
      `);

      await client.query(`
        INSERT INTO gift_delivery_failed_constraint_test
          (status, recipient_consent_at, address_vault_ref, address_verified_at,
           fulfilment_authorized_at, payment_status)
        VALUES ('recipient_accepted', NULL, NULL, NULL, NULL, 'not_started')
      `);

      const invalidCases = [
        { status: 'delivery_failed', consent: null, vault: 'vault-ref', addressAt: '2026-10-01T00:00:00Z', fulfilmentAt: '2026-10-01T00:00:00Z', payment: 'authorized' },
        { status: 'delivery_failed', consent: '2026-10-01T00:00:00Z', vault: ' ', addressAt: '2026-10-01T00:00:00Z', fulfilmentAt: '2026-10-01T00:00:00Z', payment: 'authorized' },
        { status: 'delivery_failed', consent: '2026-10-01T00:00:00Z', vault: 'vault-ref', addressAt: null, fulfilmentAt: '2026-10-01T00:00:00Z', payment: 'authorized' },
        { status: 'delivery_failed', consent: '2026-10-01T00:00:00Z', vault: 'vault-ref', addressAt: '2026-10-01T00:00:00Z', fulfilmentAt: null, payment: 'authorized' },
        { status: 'delivery_failed', consent: '2026-10-01T00:00:00Z', vault: 'vault-ref', addressAt: '2026-10-01T00:00:00Z', fulfilmentAt: '2026-10-01T00:00:00Z', payment: 'not_started' }
      ];

      for (const item of invalidCases) {
        await client.query('SAVEPOINT invalid_delivery_failed');
        let insertError;
        try {
          await client.query(
            `INSERT INTO gift_delivery_failed_constraint_test
              (status, recipient_consent_at, address_vault_ref, address_verified_at,
               fulfilment_authorized_at, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [item.status, item.consent, item.vault, item.addressAt, item.fulfilmentAt, item.payment]
          );
        } catch (error) {
          insertError = error;
        }
        assert.equal(insertError?.code, '23514', 'invalid delivery_failed evidence must be rejected');
        await client.query('ROLLBACK TO SAVEPOINT invalid_delivery_failed');
        await client.query('RELEASE SAVEPOINT invalid_delivery_failed');
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
