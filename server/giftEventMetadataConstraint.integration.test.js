import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift event metadata guard rejects sensitive keys recursively at the database boundary', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const constraint = await pool.query(
      `SELECT 1
       FROM pg_constraint
       WHERE conname = 'gift_order_events_metadata_no_sensitive_keys'
         AND conrelid = 'gift_delivery_order_events'::regclass`
    );
    assert.equal(constraint.rowCount, 1, 'migration 026 should install the metadata constraint');

    const cases = [
      { value: { reason: 'account_deleted', source: 'moderation' }, expected: false, label: 'ordinary audit metadata' },
      { value: { Address: 'private' }, expected: true, label: 'case-insensitive address key' },
      { value: { context: { recipient_phone: '+995000000' } }, expected: true, label: 'nested phone key' },
      { value: { context: [{ safe: true }, { chatMessage: 'private text' }] }, expected: true, label: 'sensitive key in an array object' },
      { value: { address_vault_ref: 'opaque-reference' }, expected: true, label: 'address vault pointer key' },
      { value: { safe: [{ reason: 'consent_withdrawn' }] }, expected: false, label: 'safe nested audit values' }
    ];

    for (const item of cases) {
      const result = await pool.query(
        'SELECT gift_event_metadata_has_forbidden_key($1::jsonb) AS forbidden',
        [JSON.stringify(item.value)]
      );
      assert.equal(result.rows[0].forbidden, item.expected, item.label);
    }
  } finally {
    await pool.end();
  }
});
