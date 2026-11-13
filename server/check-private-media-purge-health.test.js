import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePrivateMediaPurgeHealth,
  runPrivateMediaPurgeHealth
} from './check-private-media-purge-health.js';

const rows = [
  { queue_name: 'private_photo', pending: '12', due: '4', oldest_age_seconds: '3600', max_attempts: '2' },
  { queue_name: 'private_voice_intro', pending: '0', due: '0', oldest_age_seconds: '0', max_attempts: '0' }
];

test('purge health report normalizes both queues and accepts thresholds at the boundary', () => {
  const report = evaluatePrivateMediaPurgeHealth(rows, {
    maxPending: 12,
    maxOldestAgeSeconds: 3600,
    maxAttempts: 2
  });
  assert.equal(report.healthy, true);
  assert.equal(report.queues[0].pending, 12);
  assert.equal(report.queues[0].due, 4);
  assert.deepEqual(report.violations, []);
});

test('purge health report identifies each configured threshold breach', () => {
  const report = evaluatePrivateMediaPurgeHealth(rows, {
    maxPending: 10,
    maxOldestAgeSeconds: 1800,
    maxAttempts: 1
  });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.violations.map(item => item.metric), [
    'pending', 'oldestAgeSeconds', 'maxAttempts'
  ]);
  assert.ok(report.violations.every(item => item.queue === 'private_photo'));
});

test('purge health report is informational when no thresholds are configured', () => {
  const report = evaluatePrivateMediaPurgeHealth(rows);
  assert.equal(report.healthy, true);
  assert.deepEqual(report.limits, {
    maxPending: null,
    maxOldestAgeSeconds: null,
    maxAttempts: null
  });
});

test('purge health rejects invalid threshold configuration', () => {
  for (const value of [-1, 1.5, 'many', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => evaluatePrivateMediaPurgeHealth(rows, { maxPending: value }), RangeError);
  }
});

test('purge health runner uses an injected pool and does not close it', async () => {
  let closed = false;
  const pool = {
    query: async sql => {
      assert.match(sql, /private_photo_purge_queue/);
      assert.match(sql, /private_voice_intro_purge_queue/);
      return { rows };
    },
    end: async () => { closed = true; }
  };
  const report = await runPrivateMediaPurgeHealth({ pool, maxPending: 20 });
  assert.equal(report.healthy, true);
  assert.equal(closed, false);
});
