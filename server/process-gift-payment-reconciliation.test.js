import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGiftProviderOutcome, processOneGiftPaymentReconciliation, giftReconciliationRetryDelaySeconds } from './process-gift-payment-reconciliation.js';

const identity = {
  provider_key: 'sandbox_provider',
  provider_reference: 'txn_test_123',
  amount_minor_units: '12500',
  currency: 'GEL'
};

test('provider outcome must match immutable provider identity and financial snapshot', () => {
  assert.equal(validateGiftProviderOutcome({
    status: 'voided', providerKey: 'sandbox_provider',
    providerReference: 'txn_test_123', amountMinorUnits: 12500, currency: 'GEL'
  }, identity), 'voided');
  assert.throws(() => validateGiftProviderOutcome({
    status: 'voided', providerKey: 'sandbox_provider',
    providerReference: 'txn_other', amountMinorUnits: 12500, currency: 'GEL'
  }, identity), { code: 'provider_identity_or_amount_mismatch' });
  assert.throws(() => validateGiftProviderOutcome({
    status: 'captured', providerKey: 'sandbox_provider',
    providerReference: 'txn_test_123', amountMinorUnits: 12500, currency: 'GEL'
  }, identity), { code: 'provider_outcome_not_terminal' });
  assert.throws(() => validateGiftProviderOutcome({
    status: 'refunded', providerKey: 'sandbox_provider',
    providerReference: 'txn_test_123', amountMinorUnits: 12501, currency: 'GEL'
  }, identity), { code: 'provider_identity_or_amount_mismatch' });
  assert.throws(() => validateGiftProviderOutcome({
    status: 'voided', providerKey: 'other_provider',
    providerReference: 'txn_test_123', amountMinorUnits: 12500, currency: 'GEL'
  }, identity), { code: 'provider_identity_or_amount_mismatch' });
  assert.throws(() => validateGiftProviderOutcome({
    status: 'voided', providerKey: 'sandbox_provider',
    providerReference: 'txn_test_123', amountMinorUnits: 12500, currency: 'USD'
  }, identity), { code: 'provider_identity_or_amount_mismatch' });
});

test('worker fails closed before claiming when no explicit read-only lookup adapter is injected', async () => {
  let calls = 0;
  const pool = {
    connect: async () => { throw new Error('must not acquire a database connection'); },
    query: async () => { calls += 1; return { rows: [] }; }
  };
  await assert.rejects(
    processOneGiftPaymentReconciliation({ pool }),
    error => error.code === 'gift_payment_provider_adapter_not_configured'
  );
  assert.equal(calls, 0, 'must not claim or mutate tasks without a provider adapter');
});

test('worker returns idle when no due reconciliation task exists', async () => {
  const pool = {
    connect: async () => { throw new Error('must not acquire a connection when the queue is empty'); },
    query: async () => ({ rows: [] })
  };
  const result = await processOneGiftPaymentReconciliation({
    pool,
    providerAdapter: { lookup: async () => { throw new Error('must not be called'); } }
  });
  assert.deepEqual(result, { claimed: false });
});

test('reconciliation retries use bounded exponential backoff', () => {
  assert.equal(giftReconciliationRetryDelaySeconds(1), 30);
  assert.equal(giftReconciliationRetryDelaySeconds(2), 60);
  assert.equal(giftReconciliationRetryDelaySeconds(3), 120);
  assert.equal(giftReconciliationRetryDelaySeconds(8), 3600);
  assert.equal(giftReconciliationRetryDelaySeconds(100), 3600);
  assert.throws(() => giftReconciliationRetryDelaySeconds(0), RangeError);
  assert.throws(() => giftReconciliationRetryDelaySeconds(1.5), RangeError);
});
