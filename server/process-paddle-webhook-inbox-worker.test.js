import test from 'node:test';
import assert from 'node:assert/strict';
import { runPaddleWebhookInboxWorker } from './process-paddle-webhook-inbox.js';

const pool = { connect: async () => ({ release() {} }) };

test('inbox worker retries transient claim/database failures without exiting', async () => {
  let calls = 0;
  const errors = [];
  const result = await runPaddleWebhookInboxWorker({
    pool,
    metricsEveryMs: 0,
    shouldStop: () => calls >= 2,
    processOne: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'connection_reset' });
      return { claimed: true, processed: true };
    },
    wait: async milliseconds => assert.equal(milliseconds, 250),
    errorPollMs: 250,
    onError: error => errors.push(error.code),
    onResult: () => { throw new Error('metrics backend unavailable'); }
  });
  assert.deepEqual(result, { stopped: true, processed: 1, errors: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['connection_reset']);
});

test('inbox worker sleeps while idle and observes shutdown after the wait', async () => {
  let stopping = false;
  let calls = 0;
  const result = await runPaddleWebhookInboxWorker({
    pool,
    metricsEveryMs: 0,
    shouldStop: () => stopping,
    processOne: async () => { calls += 1; return { claimed: false }; },
    wait: async milliseconds => {
      assert.equal(milliseconds, 500);
      stopping = true;
    },
    idleMs: 500
  });
  assert.deepEqual(result, { stopped: true, processed: 0, errors: 0 });
  assert.equal(calls, 1);
});

test('inbox worker validates callbacks and bounded polling intervals', async () => {
  await assert.rejects(runPaddleWebhookInboxWorker({
    pool, processOne: async () => ({ claimed: false }), idleMs: 1
  }), RangeError);
  await assert.rejects(runPaddleWebhookInboxWorker({
    pool, processOne: async () => ({ claimed: false }), onError: null
  }), TypeError);
});
