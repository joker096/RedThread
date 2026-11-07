import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { deliverPendingPartnerInquiries } from './partnerInquiryDelivery.js';

const { Pool } = pg;

test('pending inquiry claim query is valid against the migrated PostgreSQL schema', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await deliverPendingPartnerInquiries(pool, async () => {
      throw new Error('The integration fixture must not contain deliverable inquiries.');
    }, { limit: 1 });
    assert.deepEqual(result, { claimed: 0, sent: 0, failed: 0, reconciliationPending: 0 });
  } finally {
    await pool.end();
  }
});
