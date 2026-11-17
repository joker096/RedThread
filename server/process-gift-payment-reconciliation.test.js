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

test('an interrupted post-lookup attempt retries by looking up the same immutable transaction, never creating one', async () => {
  let claimCount = 0;
  let lookupCount = 0;
  let firstCommitBoundaryInterrupted = false;
  let orderCommitted = false;
  const task = {
    id: 'task-1',
    order_id: 'order-1',
    lease_token: 'lease-token-1',
    lease_generation: 1,
    attempt_count: 1
  };
  const dbIdentity = {
    ...identity,
    id: 'identity-1',
    order_id: 'order-1',
    payment_status: 'authorized',
    order_status: 'pending'
  };
  const pool = {
    async query(sql) {
      if (sql.includes('claim_gift_payment_reconciliation_task')) {
        claimCount += 1;
        return { rows: [{ ...task, lease_token: `lease-token-${claimCount}`, lease_generation: claimCount, attempt_count: claimCount }] };
      }
      if (sql.includes('FROM gift_payment_attempt_identity')) return { rows: [dbIdentity] };
      if (sql.includes("SET status = 'failed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected_pool_query');
    },
    async connect() {
      if (!firstCommitBoundaryInterrupted) {
        firstCommitBoundaryInterrupted = true;
        throw Object.assign(new Error('simulated_connection_loss_after_provider_lookup_before_commit'), { code: 'simulated_connection_loss_after_provider_lookup_before_commit' });
      }
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
          if (sql.includes('UPDATE gift_delivery_orders')) {
            orderCommitted = true;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('INSERT INTO gift_delivery_order_events')) return { rowCount: 1, rows: [] };
          if (sql.includes("SET status = 'completed'")) return { rowCount: 1, rows: [] };
          throw new Error('unexpected_client_query');
        },
        release() {}
      };
    }
  };
  const providerAdapter = {
    async lookup(args) {
      lookupCount += 1;
      assert.deepEqual(args, {
        providerKey: 'sandbox_provider',
        providerReference: 'txn_test_123',
        idempotencyKey: dbIdentity.idempotency_key
      });
      return {
        status: 'voided',
        providerKey: 'sandbox_provider',
        providerReference: 'txn_test_123',
        amountMinorUnits: 12500,
        currency: 'GEL'
      };
    }
  };

  const interrupted = await processOneGiftPaymentReconciliation({ pool, providerAdapter });
  assert.equal(interrupted.completed, false);
  assert.equal(interrupted.code, 'simulated_connection_loss_after_provider_lookup_before_commit');
  assert.equal(orderCommitted, false);

  const recovered = await processOneGiftPaymentReconciliation({ pool, providerAdapter });
  assert.equal(recovered.completed, true);
  assert.equal(recovered.status, 'voided');
  assert.equal(lookupCount, 2, 'recovery must query the same existing provider transaction again');
  assert.equal(claimCount, 2);
  assert.equal(orderCommitted, true);
  assert.equal(typeof providerAdapter.create, 'undefined');
  assert.equal(typeof providerAdapter.authorize, 'undefined');
  assert.equal(typeof providerAdapter.capture, 'undefined');
  assert.equal(typeof providerAdapter.refund, 'undefined');
});
