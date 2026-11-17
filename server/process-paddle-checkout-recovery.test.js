import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS,
  PADDLE_CHECKOUT_RECOVERY_MAX_PAGES,
  paddleRecoveryWindow,
  paddleRecoveryTransactionMatches,
  paddleRecoveryDecision,
  listPaddleTransactionsForAttempt
} from './process-paddle-checkout-recovery.js';

const attempt = {
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  attempt_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  plan: '1month',
  created_at: '2026-11-17T07:00:00.000Z'
};
const transaction = (overrides = {}) => ({
  id: 'txn_abc123',
  status: 'ready',
  custom_data: { userId: attempt.user_id, plan: attempt.plan, checkoutAttemptId: attempt.attempt_id },
  items: [{ price: { id: 'pri_month' }, quantity: 1 }],
  ...overrides
});

test('recovery bounds and time window are deterministic', () => {
  assert.equal(PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS, 5);
  assert.equal(PADDLE_CHECKOUT_RECOVERY_MAX_PAGES, 5);
  assert.deepEqual(paddleRecoveryWindow(attempt.created_at, Date.parse('2026-11-17T07:03:00Z')), {
    from: '2026-11-17T06:59:00.000Z',
    to: '2026-11-17T07:03:30.000Z'
  });
  assert.throws(() => paddleRecoveryWindow('not-a-date'), TypeError);
});

test('only exact attempt, owner, plan, configured price and quantity are matched', () => {
  assert.deepEqual(paddleRecoveryTransactionMatches(transaction(), attempt, 'pri_month'), {
    kind: 'match', transactionId: 'txn_abc123', status: 'ready'
  });
  assert.equal(paddleRecoveryTransactionMatches(transaction({
    custom_data: { ...transaction().custom_data, checkoutAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
  }), attempt, 'pri_month').kind, 'no_match');
  assert.equal(paddleRecoveryTransactionMatches(transaction({
    custom_data: { ...transaction().custom_data, userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
  }), attempt, 'pri_month').kind, 'identity_conflict');
  assert.equal(paddleRecoveryTransactionMatches(transaction({
    items: [{ price: { id: 'pri_other' }, quantity: 1 }]
  }), attempt, 'pri_month').kind, 'price_conflict');
  assert.equal(paddleRecoveryTransactionMatches(transaction({
    items: [{ price: { id: 'pri_month' }, quantity: 2 }]
  }), attempt, 'pri_month').kind, 'price_conflict');
});

test('zero, unique, duplicate and paid matches fail closed', () => {
  assert.equal(paddleRecoveryDecision([]).action, 'not_found');
  assert.equal(paddleRecoveryDecision([], { pageLimitReached: true }).action, 'defer');
  assert.equal(paddleRecoveryDecision([paddleRecoveryTransactionMatches(transaction(), attempt, 'pri_month')]).action, 'attach_pending');
  assert.equal(paddleRecoveryDecision([
    paddleRecoveryTransactionMatches(transaction(), attempt, 'pri_month'),
    paddleRecoveryTransactionMatches(transaction({ id: 'txn_other123' }), attempt, 'pri_month')
  ]).reason, 'multiple_provider_matches');
  assert.equal(paddleRecoveryDecision([
    paddleRecoveryTransactionMatches(transaction({ status: 'completed' }), attempt, 'pri_month')
  ]).action, 'quarantine_with_transaction');
});

test('transaction list uses sandbox endpoint, bounded cursor pagination and exact metadata matching', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          data: [transaction()],
          meta: { pagination: { has_more: false, next: 'https://sandbox-api.paddle.com/transactions?after=txn_abc123' } }
        };
      }
    };
  };
  const result = await listPaddleTransactionsForAttempt({
    apiKey: 'sandbox_test_key', attempt, fetchImpl, priceId: 'pri_month',
    now: Date.parse('2026-11-17T07:03:00Z')
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/sandbox-api\.paddle\.com\/transactions\?/);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].kind, 'match');
});

test('pagination never follows an untrusted host', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { data: [], meta: { pagination: { has_more: true, next: 'https://evil.example/transactions?after=txn_abc123' } } };
    }
  });
  await assert.rejects(
    listPaddleTransactionsForAttempt({ apiKey: 'sandbox_test_key', attempt, fetchImpl, priceId: 'pri_month' }),
    /pagination_url_invalid/
  );
});
