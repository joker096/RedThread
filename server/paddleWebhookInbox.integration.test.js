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
  PADDLE_WEBHOOK_MAX_ATTEMPTS
} from './paddleWebhookInbox.js';

const { Pool } = pg;

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
    assert.deepEqual(first, { duplicate: false, queued: true });
    const duplicate = await enqueueVerifiedPaddleWebhook(pool, event);
    assert.deepEqual(duplicate, { duplicate: true, queued: false });

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
