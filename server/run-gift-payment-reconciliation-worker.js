import { processOneGiftPaymentReconciliation } from './process-gift-payment-reconciliation.js';

function waitForNextPoll(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Runs the reconciliation loop with an explicitly injected read-only provider
 * adapter. It never creates or changes provider transactions. No adapter means
 * no loop: startup fails closed before any queue claim.
 */
export async function runGiftPaymentReconciliationWorker({
  pool,
  providerAdapter,
  signal,
  workerId,
  leaseSeconds = 90,
  maxAttempts = 8,
  idlePollMs = 1_000,
  errorPollMs = 5_000,
  onError = () => {},
  processOne = processOneGiftPaymentReconciliation
}) {
  if (!pool?.connect) throw new TypeError('database_pool_required');
  if (!providerAdapter || typeof providerAdapter.lookup !== 'function') {
    throw Object.assign(new Error('gift_payment_provider_adapter_not_configured'), {
      code: 'gift_payment_provider_adapter_not_configured'
    });
  }
  if (!signal || typeof signal.addEventListener !== 'function') {
    throw new TypeError('worker_abort_signal_required');
  }
  if (!Number.isInteger(idlePollMs) || idlePollMs < 100 || idlePollMs > 60_000
      || !Number.isInteger(errorPollMs) || errorPollMs < 100 || errorPollMs > 300_000) {
    throw new RangeError('gift_reconciliation_poll_interval_invalid');
  }
  if (typeof processOne !== 'function' || typeof onError !== 'function') {
    throw new TypeError('worker_callback_invalid');
  }

  let processed = 0;
  let errors = 0;
  while (!signal.aborted) {
    try {
      const result = await processOne({
        pool, providerAdapter, workerId, leaseSeconds, maxAttempts
      });
      if (result?.claimed) {
        processed += 1;
        continue;
      }
      await waitForNextPoll(idlePollMs, signal);
    } catch (error) {
      errors += 1;
      try { onError(error); } catch { /* Logging hooks must not crash the worker loop. */ }
      await waitForNextPoll(errorPollMs, signal);
    }
  }
  return { stopped: true, processed, errors };
}
