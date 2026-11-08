import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CANCEL_PARTNER_INQUIRY_SQL, CLAIM_PARTNER_INQUIRY_SQL, MY_PARTNER_INQUIRIES_SQL, PENDING_PARTNER_INQUIRIES_SQL, REVALIDATE_PARTNER_INQUIRY_SQL, RECOVER_PARTNER_INQUIRY_SQL } from './partnerInquiryDelivery.js';

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
    const eligibilityPlan = await pool.query('EXPLAIN ' + REVALIDATE_PARTNER_INQUIRY_SQL, ['00000000-0000-4000-8000-000000000001']);
    assert.ok(eligibilityPlan.rows.length > 0, 'PostgreSQL must plan the final pre-send eligibility and consent recheck');
    const recoveryPlan = await pool.query('EXPLAIN ' + RECOVER_PARTNER_INQUIRY_SQL, ['00000000-0000-4000-8000-000000000001']);
    assert.ok(recoveryPlan.rows.length > 0, 'PostgreSQL must plan explicit recovery without an age-based stale predicate');
    const ownInquiriesPlan = await pool.query('EXPLAIN ' + MY_PARTNER_INQUIRIES_SQL, ['00000000-0000-4000-8000-000000000002']);
    assert.ok(ownInquiriesPlan.rows.length > 0, 'PostgreSQL must plan the owner-scoped inquiry history query');
    const cancelPlan = await pool.query('EXPLAIN ' + CANCEL_PARTNER_INQUIRY_SQL, ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    assert.ok(cancelPlan.rows.length > 0, 'PostgreSQL must plan the requester withdrawal query');
    const providerMessageColumn = await pool.query('SELECT provider_message_id, contact_consent_version, cancelled_at FROM partner_service_inquiries LIMIT 0');
    assert.equal(providerMessageColumn.rowCount, 0, 'migrations 221, 222 and 224 must add provider message, consent and withdrawal audit fields');
    const providerStatusConstraint = await pool.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'partner_service_inquiry_provider_message_status_valid' AND conrelid = 'partner_service_inquiries'::regclass"
    );
    assert.equal(providerStatusConstraint.rowCount, 1, 'migration 223 must prevent a provider-accepted message from being reconciled as not accepted');
    const cancelledAtConstraint = await pool.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'partner_service_inquiry_cancelled_at_valid' AND conrelid = 'partner_service_inquiries'::regclass"
    );
    assert.equal(cancelledAtConstraint.rowCount, 1, 'migration 224 must keep cancelled_at consistent with the cancelled state');
    const statusConstraint = await pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'partner_service_inquiries_delivery_status_check' AND conrelid = 'partner_service_inquiries'::regclass"
    );
    assert.match(statusConstraint.rows[0]?.definition || '', /cancelled/);
    const evidenceTrigger = await pool.query(
      "SELECT 1 FROM pg_trigger WHERE tgname = 'partner_service_inquiry_evidence_immutable' AND tgrelid = 'partner_service_inquiries'::regclass AND NOT tgisinternal"
    );
    assert.equal(evidenceTrigger.rowCount, 1, 'migration 225 must freeze the request, consent snapshot and accepted provider message ID');
  } finally {
    await pool.end();
  }
});
