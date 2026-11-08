import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PENDING_PARTNER_INQUIRIES_SQL } from './partnerInquiryDelivery.js';

const { Pool } = pg;

test('pending inquiry claim query is valid against the migrated PostgreSQL schema', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await pool.query('EXPLAIN ' + PENDING_PARTNER_INQUIRIES_SQL, [1]);
    assert.ok(result.rows.length > 0, 'PostgreSQL must plan the pending inquiry claim query');
  } finally {
    await pool.end();
  }
});
