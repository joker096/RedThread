import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPaddleWebhookInboxMetrics,
  paddleWebhookInboxAlerts,
  runPaddleWebhookInboxWorker
} from './process-paddle-webhook-inbox.js';

test('inbox metrics expose aggregate queue health without event-level fields', async () => {
  let query;
  const pool = { async query(sql) {
    query = String(sql);
    return { rows: [{
      pending_count: '2', retry_count: '3', processing_count: '4',
      expired_lease_count: '1', dead_letter_count: '5', due_count: '6',
      oldest_unfinished_age_seconds: '301'
    }] };
  } };
  const metrics = await getPaddleWebhookInboxMetrics(pool);
  assert.deepEqual(metrics, {
    pendingCount: 2, retryCount: 3, processingCount: 4,
    expiredLeaseCount: 1, deadLetterCount: 5, dueCount: 6,
    oldestUnfinishedAgeSeconds: 301
  });
  assert.match(query, /COUNT\(\*\) FILTER/);
  assert.doesNotMatch(query, /payload|event_id|user_id/i);
});

test('queue alert thresholds flag dead letters, expired leases, stale work and backlog', () => {
  assert.deepEqual(paddleWebhookInboxAlerts({
    deadLetterCount: 1, expiredLeaseCount: 2, oldestUnfinishedAgeSeconds: 300, dueCount: 100
  }), [
    'dead_letter_events_present',
    'expired_worker_leases_present',
    'oldest_event_over_5m',
    'backlog_over_100_due_events'
  ]);
  assert.deepEqual(paddleWebhookInboxAlerts({
    deadLetterCount: 0, expiredLeaseCount: 0, oldestUnfinishedAgeSeconds: 299, dueCount: 99
  }), []);
});

test('metrics callback runs independently and cannot stop queue consumption', async () => {
  let stopping = false;
  let metricsCalls = 0;
  let processedCalls = 0;
  const result = await runPaddleWebhookInboxWorker({
    pool: { connect: async () => ({ release() {} }) },
    shouldStop: () => stopping,
    metricsEveryMs: 1,
    readMetrics: async () => { metricsCalls += 1; return { dueCount: 0 }; },
    onMetrics: () => { throw new Error('metrics sink unavailable'); },
    processOne: async () => {
      processedCalls += 1;
      stopping = true;
      return { claimed: false };
    }
  });
  assert.equal(metricsCalls, 1);
  assert.equal(processedCalls, 1);
  assert.deepEqual(result, { stopped: true, processed: 0, errors: 0 });
});
