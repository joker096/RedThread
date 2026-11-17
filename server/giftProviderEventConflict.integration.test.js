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

    const invalidConflictInsert = (provider, event, originalHash, nextHash, eventType) =>
      client.query(
        'INSERT INTO gift_payment_provider_event_conflicts ' +
        '(provider_key, provider_event_id, original_payload_sha256, conflicting_payload_sha256, conflicting_event_type) ' +
        'VALUES ($1, $2, $3, $4, $5)',
        [provider, event, originalHash, nextHash, eventType]
      );

    await assert.rejects(
      invalidConflictInsert(providerKey, '   ', firstHash, conflictHash, 'transaction.updated'),
      error => error.code === '23514',
      'conflict evidence must reject blank provider event IDs'
    );
    await assert.rejects(
      invalidConflictInsert(' ', eventId, firstHash, conflictHash, 'transaction.updated'),
      error => error.code === '23514',
      'conflict evidence must reject malformed provider keys'
    );
    await assert.rejects(
      invalidConflictInsert(providerKey, eventId, firstHash, conflictHash, 'Invalid Event Type'),
      error => error.code === '23514',
      'conflict evidence must reject malformed event types'
    );

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

    const repeatedConflict = await client.query(
      'SELECT record_verified_gift_provider_event($1, $2, $3, $4, $5) AS result',
      [providerKey, eventId, 'transaction.refunded', conflictHash, '2026-01-02T00:00:00Z']
    );
    assert.equal(repeatedConflict.rows[0].result, 'conflict');
    const conflictCount = await client.query(
      'SELECT COUNT(*)::int AS count FROM gift_payment_provider_event_conflicts WHERE provider_key = $1 AND provider_event_id = $2',
      [providerKey, eventId]
    );
    assert.equal(conflictCount.rows[0].count, 1);

    // Two independent database sessions race to insert the same provider event.
    // Exactly one may create the inbox row; the other must observe a duplicate.
    const concurrentEventId = `test_concurrent_${randomUUID()}`;
    const concurrentResults = await Promise.all([
      pool.query(
        'SELECT record_verified_gift_provider_event($1, $2, $3, $4, $5) AS result',
        [providerKey, concurrentEventId, 'transaction.updated', firstHash, '2026-01-03T00:00:00Z']
      ),
      pool.query(
        'SELECT record_verified_gift_provider_event($1, $2, $3, $4, $5) AS result',
        [providerKey, concurrentEventId, 'transaction.updated', firstHash, '2026-01-03T00:00:00Z']
      )
    ]);
    assert.deepEqual(
      concurrentResults.map(result => result.rows[0].result).sort(),
      ['duplicate', 'inserted']
    );
    const concurrentInbox = await client.query(
      'SELECT COUNT(*)::int AS count FROM gift_payment_provider_event_inbox WHERE provider_key = $1 AND provider_event_id = $2',
      [providerKey, concurrentEventId]
    );
    assert.equal(concurrentInbox.rows[0].count, 1);
  } finally {
    // Event and conflict evidence are intentionally append-only. The CI database is disposable.
    client.release();
    await pool.end();
  }
});
