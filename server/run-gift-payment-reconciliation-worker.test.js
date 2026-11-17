import test from 'node:test';
import assert from 'node:assert/strict';
import { runGiftPaymentReconciliationWorker } from './run-gift-payment-reconciliation-worker.js';

const pool = { connect: async () => ({ release() {} }) };
const adapter = { lookup: async () => ({}) };

test('gift reconciliation worker fails closed before starting without a read-only provider adapter', async () => {
  let calls = 0;
  await assert.rejects(
    runGiftPaymentReconciliationWorker({
      pool: { connect: async () => { calls += 1; } },
      signal: new AbortController().signal
    }),
    error => error.code === 'gift_payment_provider_adapter_not_configured'
  );
  assert.equal(calls, 0);
});

test('gift reconciliation worker polls idle queue and stops promptly on abort', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runGiftPaymentReconciliationWorker({
    pool, providerAdapter: adapter, signal: controller.signal,
    idlePollMs: 100, errorPollMs: 100,
    processOne: async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { claimed: false };
    }
  });
  assert.deepEqual(result, { stopped: true, processed: 0, errors: 0 });
  assert.equal(calls, 2);
});

test('gift reconciliation worker processes claimed tasks continuously and isolates loop errors', async () => {
  const controller = new AbortController();
  const observedErrors = [];
  let calls = 0;
  const result = await runGiftPaymentReconciliationWorker({
    pool, providerAdapter: adapter, signal: controller.signal,
    idlePollMs: 100, errorPollMs: 100,
    onError: error => observedErrors.push(error.message),
    processOne: async () => {
      calls += 1;
      if (calls === 1) return { claimed: true, completed: true };
      if (calls === 2) throw new Error('transient_db_error');
      controller.abort();
      return { claimed: false };
    }
  });
  assert.deepEqual(result, { stopped: true, processed: 1, errors: 1 });
  assert.deepEqual(observedErrors, ['transient_db_error']);
  assert.equal(calls, 3);
});

test('gift reconciliation worker validates bounded polling intervals', async () => {
  await assert.rejects(
    runGiftPaymentReconciliationWorker({
      pool, providerAdapter: adapter, signal: new AbortController().signal,
      idlePollMs: 1
    }),
    RangeError
  );
});
