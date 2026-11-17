import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  enqueueVerifiedPaddleWebhook,
  claimPaddleWebhook,
  completePaddleWebhook,
  processOnePaddleWebhook,
  paddleWebhookRetryDelayMs,
  PADDLE_WEBHOOK_MAX_ATTEMPTS,
  stableJsonStringify
} from './paddleWebhookInbox.js';

const { Pool } = pg;


test('canonical Paddle webhook serialization preserves hydrated dates and rejects unsupported objects', () => {
  const first = stableJsonStringify({ occurredAt: new Date('2026-11-17T10:00:00.000Z'), data: { id: 'txn_1' } });
  const same = stableJsonStringify({ data: { id: 'txn_1' }, occurredAt: new Date('2026-11-17T10:00:00.000Z') });
  const different = stableJsonStringify({ occurredAt: new Date('2026-11-17T10:00:01.000Z'), data: { id: 'txn_1' } });
  assert.equal(first, same, 'object key order must not affect canonical serialization');
  assert.notEqual(first, different, 'different hydrated provider timestamps must remain distinguishable');
  assert.throws(() => stableJsonStringify({ occurredAt: new Date('invalid') }), { message: 'invalid_paddle_event_date' });
  class ProviderObject { constructor() { this.value = 1; } }
  assert.throws(() => stableJsonStringify({ nested: new ProviderObject() }), { message: 'unsupported_paddle_event_object' });
});

test('Paddle webhook inbox retry policy is bounded and exponential', () => {
  assert.equal(paddleWebhookRetryDelayMs(1), 5_000);
  assert.equal(paddleWebhookRetryDelayMs(2), 10_000);
  assert.equal(paddleWebhookRetryDelayMs(8), 640_000);
  assert.throws(() => paddleWebhookRetryDelayMs(0), RangeError);
  assert.throws(() => paddleWebhookRetryDelayMs(PADDLE_WEBHOOK_MAX_ATTEMPTS + 1), RangeError);
});

test('verified Paddle events are durably deduplicated and worker completion is fenced', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const eventId = 'evt_test_' + randomUUID().replaceAll('-', '');
  const event = {
    eventId,
    eventType: 'transaction.completed',
    occurredAt: new Date().toISOString(),
    data: { id: 'txn_test_' + randomUUID().replaceAll('-', ''), customData: { test: true } }
  };
  try {
    const first = await enqueueVerifiedPaddleWebhook(pool, event);
    assert.deepEqual(first, { duplicate: false, queued: true, conflict: false });
    const duplicate = await enqueueVerifiedPaddleWebhook(pool, event);
    assert.deepEqual(duplicate, { duplicate: true, queued: false, conflict: false });

    const processed = await processOnePaddleWebhook(pool, async (_pool, payload) => {
      assert.equal(payload.eventId, eventId);
    });
    assert.equal(processed.claimed, true);
    assert.equal(processed.processed, true);

    const completed = await pool.query(
      'SELECT status, attempt_count, payload, processed_at, lease_token FROM paddle_webhook_inbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(completed.rows[0].status, 'completed');
    assert.equal(completed.rows[0].attempt_count, 1);
    assert.equal(completed.rows[0].payload, null);
    assert.ok(completed.rows[0].processed_at);
    assert.equal(completed.rows[0].lease_token, null);

    // Reusing a verified event ID with different content is not an ordinary
    // duplicate: retain immutable hash-only evidence without overwriting the
    // first delivery or replaying its financial effects.
    const conflictingEvent = {
      ...event,
      data: { ...event.data, id: 'txn_conflicting_' + randomUUID().replaceAll('-', '') }
    };
    const conflict = await enqueueVerifiedPaddleWebhook(pool, conflictingEvent);
    assert.deepEqual(conflict, { duplicate: true, queued: false, conflict: true });
    const conflictEvidence = await pool.query(
      `SELECT inbox.payload_sha256, conflict.original_payload_sha256,
              conflict.conflicting_payload_sha256, inbox.status
         FROM paddle_webhook_inbox AS inbox
         JOIN paddle_webhook_inbox_conflicts AS conflict USING (event_id)
        WHERE inbox.event_id = $1`,
      [eventId]
    );
    assert.equal(conflictEvidence.rowCount, 1);
    assert.equal(conflictEvidence.rows[0].original_payload_sha256, conflictEvidence.rows[0].payload_sha256);
    assert.notEqual(conflictEvidence.rows[0].conflicting_payload_sha256, conflictEvidence.rows[0].payload_sha256);
    assert.equal(conflictEvidence.rows[0].status, 'completed');
    assert.deepEqual(
      await enqueueVerifiedPaddleWebhook(pool, conflictingEvent),
      { duplicate: true, queued: false, conflict: true }
    );
    const conflictCount = await pool.query(
      'SELECT COUNT(*)::int AS count FROM paddle_webhook_inbox_conflicts WHERE event_id = $1',
      [eventId]
    );
    assert.equal(conflictCount.rows[0].count, 1);

    // A conflict discovered before claim moves pending work to dead-letter;
    // the worker must not process the original payload after the conflict.
    const quarantinedEventId = eventId + '_quarantined';
    await enqueueVerifiedPaddleWebhook(pool, { ...event, eventId: quarantinedEventId });
    await enqueueVerifiedPaddleWebhook(pool, {
      ...event, eventId: quarantinedEventId,
      data: { ...event.data, id: 'txn_conflicting_' + randomUUID().replaceAll('-', '') }
    });
    const quarantined = await pool.query(
      'SELECT status, payload, last_error_code FROM paddle_webhook_inbox WHERE event_id = $1',
      [quarantinedEventId]
    );
    assert.equal(quarantined.rows[0].status, 'dead_letter');
    assert.equal(quarantined.rows[0].payload, null);
    assert.equal(quarantined.rows[0].last_error_code, 'event_id_payload_conflict');

    // Simulate a crash after the domain event has committed but before inbox
    // completion. Replay must hit the domain event's own unique event ID and
    // therefore must not repeat the side effect.
    const crashEventId = eventId + '_crash';
    await enqueueVerifiedPaddleWebhook(pool, { ...event, eventId: crashEventId });
    let firstDelivery = true;
    let domainEffects = 0;
    const processWithCrash = async (db, payload) => {
      const persisted = await db.query(
        `INSERT INTO paddle_webhook_events (event_id, event_type)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [payload.eventId, payload.eventType]
      );
      if (persisted.rowCount === 1) domainEffects += 1;
      if (firstDelivery) {
        firstDelivery = false;
        throw Object.assign(new Error('simulated_crash_after_domain_commit'), {
          code: 'simulated_crash_after_domain_commit'
        });
      }
    };
    const interrupted = await processOnePaddleWebhook(pool, processWithCrash);
    assert.equal(interrupted.processed, false);
    assert.equal(interrupted.retryScheduled, true);
    await pool.query(
      `UPDATE paddle_webhook_inbox
          SET next_attempt_at = statement_timestamp()
        WHERE event_id = $1 AND status = 'retry'`,
      [crashEventId]
    );
    const recovered = await processOnePaddleWebhook(pool, processWithCrash);
    assert.equal(recovered.processed, true);
    assert.equal(domainEffects, 1);

    // Two concurrent workers must never claim the same inbox row.
    const concurrentEventId = eventId + '_concurrent';
    await enqueueVerifiedPaddleWebhook(pool, { ...event, eventId: concurrentEventId });
    const concurrentClaims = await Promise.all([
      claimPaddleWebhook(pool),
      claimPaddleWebhook(pool)
    ]);
    assert.equal(concurrentClaims.filter(Boolean).length, 1);
    const onlyClaim = concurrentClaims.find(Boolean);
    assert.equal(await completePaddleWebhook(pool, concurrentEventId, onlyClaim.lease_token), true);

    const staleEventId = eventId + '_stale';
    await enqueueVerifiedPaddleWebhook(pool, { ...event, eventId: staleEventId });
    const claimed = await claimPaddleWebhook(pool);
    assert.equal(claimed.event_id, staleEventId);
    const replacementToken = randomUUID();
    await pool.query(
      "UPDATE paddle_webhook_inbox SET lease_token = $2::uuid WHERE event_id = $1",
      [staleEventId, replacementToken]
    );
    assert.equal(await completePaddleWebhook(pool, staleEventId, claimed.lease_token), false,
      'a worker holding an obsolete fencing token cannot complete the event');
    await pool.query(
      "UPDATE paddle_webhook_inbox SET status = 'retry', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = statement_timestamp() WHERE event_id = $1",
      [staleEventId]
    );
  } finally {
    await pool.query('DELETE FROM paddle_webhook_inbox WHERE event_id = ANY($1::text[])', [[eventId, eventId + '_stale']]).catch(() => {});
    await pool.end();
  }
});
