import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CLAIM_PARTNER_INQUIRY_SQL, PENDING_PARTNER_INQUIRIES_SQL } from './partnerInquiryDelivery.js';

const { Pool } = pg;

test('pending inquiry claim query is valid against the migrated PostgreSQL schema', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await pool.query('EXPLAIN ' + PENDING_PARTNER_INQUIRIES_SQL, [1]);
    assert.ok(result.rows.length > 0, 'PostgreSQL must plan the pending inquiry claim query');
    const claimPlan = await pool.query('EXPLAIN ' + CLAIM_PARTNER_INQUIRY_SQL, ['00000000-0000-4000-8000-000000000001']);
    assert.ok(claimPlan.rows.length > 0, 'PostgreSQL must plan the guarded synchronous inquiry claim query');
    const providerMessageColumn = await pool.query('SELECT provider_message_id, contact_consent_version FROM partner_service_inquiries LIMIT 0');
    assert.equal(providerMessageColumn.rowCount, 0, 'migrations 221 and 222 must add provider message and consent audit fields');
  } finally {
    await pool.end();
  }
});
