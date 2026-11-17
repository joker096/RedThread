import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift payment reconciliation ledger installs fenced claim and immutable inbox guards', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const functions = await client.query(
      `SELECT proname FROM pg_proc
        WHERE proname IN (
          'claim_gift_payment_reconciliation_task',
          'heartbeat_gift_payment_reconciliation_task',
          'guard_gift_payment_provider_event_inbox',
          'guard_gift_payment_attempt_identity'
        )`
    );
    const names = new Set(functions.rows.map(row => row.proname));
    for (const name of [
      'claim_gift_payment_reconciliation_task',
      'heartbeat_gift_payment_reconciliation_task',
      'guard_gift_payment_provider_event_inbox',
      'guard_gift_payment_attempt_identity'
    ]) assert.ok(names.has(name), `migration 212 must install ${name}`);

    await assert.rejects(
      client.query('SELECT * FROM claim_gift_payment_reconciliation_task($1, 90, 8)', ['invalid worker name with spaces']),
      error => error.code === '22023'
    );

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO gift_payment_provider_event_inbox
         (provider_key, provider_event_id, event_type, payload_sha256)
       VALUES ('test_provider', $1, 'transaction.updated', repeat('a', 64))
       RETURNING id`,
      [`event_${Date.now()}_${Math.random().toString(16).slice(2)}`]
    );
    const id = inserted.rows[0].id;
    await assert.rejects(
      client.query(
        'UPDATE gift_payment_provider_event_inbox SET payload_sha256 = repeat(\'b\', 64) WHERE id = $1',
        [id]
      ),
      error => error.code === '55000'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});
