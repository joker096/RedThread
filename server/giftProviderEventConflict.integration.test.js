import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('verified gift provider event recording deduplicates and preserves conflicting event-ID evidence', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = `test_${randomUUID()}`;
  const providerKey = 'test_provider';
  const firstHash = 'a'.repeat(64);
  const conflictHash = 'b'.repeat(64);
  try {
    const inserted = await client.query(
      'SELECT record_verified_gift_provider_event($1, $2, $3, $4, $5) AS result',
      [providerKey, eventId, 'transaction.updated', firstHash, '2026-01-01T00:00:00Z']
    );
    assert.equal(inserted.rows[0].result, 'inserted');

    const duplicate = await client.query(
      'SELECT record_verified_gift_provider_event($1, $2, $3, $4, $5) AS result',
      [providerKey, eventId, 'transaction.updated', firstHash, '2026-01-01T00:00:00Z']
    );
    assert.equal(duplicate.rows[0].result, 'duplicate');

    const conflict = await client.query(
      'SELECT record_verified_gift_provider_event($1, $2, $3, $4, $5) AS result',
      [providerKey, eventId, 'transaction.refunded', conflictHash, '2026-01-02T00:00:00Z']
    );
    assert.equal(conflict.rows[0].result, 'conflict');

    const original = await client.query(
      'SELECT payload_sha256, processing_status, quarantine_code FROM gift_payment_provider_event_inbox WHERE provider_key = $1 AND provider_event_id = $2',
      [providerKey, eventId]
    );
    assert.equal(original.rowCount, 1);
    assert.equal(original.rows[0].payload_sha256, firstHash);
    assert.equal(original.rows[0].processing_status, 'quarantined');
    assert.equal(original.rows[0].quarantine_code, 'event_id_payload_conflict');

    const evidence = await client.query(
      'SELECT original_payload_sha256, conflicting_payload_sha256 FROM gift_payment_provider_event_conflicts WHERE provider_key = $1 AND provider_event_id = $2',
      [providerKey, eventId]
    );
    assert.equal(evidence.rowCount, 1);
    assert.equal(evidence.rows[0].original_payload_sha256, firstHash);
    assert.equal(evidence.rows[0].conflicting_payload_sha256, conflictHash);

    await assert.rejects(
      client.query('UPDATE gift_payment_provider_event_conflicts SET conflicting_event_type = $1 WHERE provider_key = $2 AND provider_event_id = $3', ['tampered', providerKey, eventId]),
      error => error.code === '55000'
    );
  } finally {
    // Event and conflict evidence are intentionally append-only. The CI database is disposable.
    client.release();
    await pool.end();
  }
});
