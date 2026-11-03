import test from 'node:test';
import assert from 'node:assert/strict';
import { processPaddleEvent } from './paddleBilling.js';

const userId = '00000000-0000-4000-8000-000000000001';
const transactionId = 'txn_0123456789abcdef01234567';
let eventCounter = 0;

function makePool({ ledgerStatus = 'active', revokeReason = null, fullRefund = false, chargeback = false, linkedRowCount = 1, linkedPlan = 'lifetime', linkedStatus = 'linked', userStatus = 'active' } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('INSERT INTO paddle_adjustment_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT user_id, plan,') && statement.includes('bool_or(status = \'linked\')')) {
        return { rowCount: linkedRowCount, rows: linkedRowCount ? [{ user_id: userId, plan: linkedPlan, status: linkedStatus }] : [] };
      }
      if (statement.includes('SELECT id, status, premium_lifetime FROM users')) {
        return { rowCount: 1, rows: [{ id: userId, status: userStatus, premium_lifetime: true }] };
      }
      if (statement.includes('SELECT status, revoke_reason FROM paddle_lifetime_entitlements')) {
        return { rowCount: 1, rows: [{ status: ledgerStatus, revoke_reason: revokeReason }] };
      }
      if (statement.includes('WITH latest_per_adjustment AS')) {
        return { rowCount: 1, rows: [{ full_refund_active: fullRefund, chargeback_active: chargeback }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  return {
    calls,
    pool: { async connect() { return client; } }
  };
}

async function sendAdjustment(pool, { eventId, action, status, type = 'partial', eventType = 'adjustment.created', amount = '500', currencyCode = 'USD' } = {}) {
  return processPaddleEvent(pool, {
    eventId: eventId || 'evt_' + String(++eventCounter).padStart(26, '0'),
    eventType,
    occurredAt: '2026-11-03T10:00:00Z',
    data: {
      id: 'adj_0123456789abcdef01234567',
      transactionId,
      action,
      type,
      status,
      currency_code: currencyCode,
      totals: { total: amount, currency_code: currencyCode }
    }
  });
}

test('adjustments for recurring transactions use the transaction ledger and never enter lifetime reconciliation', async () => {
  const { pool, calls } = makePool({ linkedPlan: '1month', linkedStatus: 'linked' });
  const result = await sendAdjustment(pool, {
    action: 'refund', status: 'approved', type: 'full'
  });
  assert.equal(result.handled, true);
  assert.equal(result.adjustmentRecorded, true);
  assert.equal(result.entitlementChanged, false);
  assert.equal(result.reconciliationRequired, undefined);
  assert.equal(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')), false);
  assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_lifetime_entitlements')), false);
});

test('pending and rejected full refunds never revoke lifetime Premium', async () => {
  for (const status of ['pending_approval', 'rejected']) {
    const { pool, calls } = makePool({ ledgerStatus: 'active' });
    const result = await sendAdjustment(pool, { action: 'refund', status, type: 'full' });
    assert.equal(result.handled, true);
    assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_lifetime_entitlements')), false);
    assert.equal(calls.some(call => call.statement.includes('UPDATE users')), false);
  }
});

test('approved full refunds revoke the matching lifetime entitlement', async () => {
  const { pool, calls } = makePool({ ledgerStatus: 'active', fullRefund: true });
  const result = await sendAdjustment(pool, {
    action: 'refund', status: 'approved', type: 'full', eventType: 'adjustment.updated'
  });
  assert.equal(result.premiumRevoked, true);
  const transactionLookup = calls.find(call => call.statement.includes('FROM paddle_transaction_events'));
  assert.match(transactionLookup.statement, /plan IN \('1month', '3months'\)/,
    'the transaction ledger may resolve recurring renewals but must not bypass verified lifetime checkout attempts');
  const adjustmentStateQuery = calls.find(call => call.statement.includes('WITH latest_per_adjustment AS'));
  assert.match(adjustmentStateQuery.statement, /WHEN 'pending_approval' THEN 0[\\s\\S]*WHEN 'reversed' THEN 3/,
    'final approval/rejection/reversal states must outrank a same-time pending webhook');
  const adjustmentLedger = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_events'));
  assert.equal(adjustmentLedger.params[6], '500');
  assert.equal(adjustmentLedger.params[7], 'USD');
  const update = calls.find(call => call.statement.includes('UPDATE paddle_lifetime_entitlements'));
  assert.deepEqual(update.params, [transactionId, userId, 'revoked', 'paddle_full_refund']);
  assert.ok(calls.some(call => call.statement.includes('UPDATE users')));
});

test('partial refunds and chargeback warnings do not revoke lifetime Premium', async () => {
  for (const [action, status] of [['refund', 'approved'], ['chargeback_warning', 'approved']]) {
    const { pool, calls } = makePool({ ledgerStatus: 'active' });
    const result = await sendAdjustment(pool, { action, status, type: 'partial' });
    assert.equal(result.entitlementChanged, false);
    assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_lifetime_entitlements')), false);
  }
});

test('chargeback entitlement predicate requires an approved, non-warning dispute', async () => {
  const { pool, calls } = makePool({ ledgerStatus: 'active', chargeback: false });
  await sendAdjustment(pool, { action: 'chargeback', status: 'rejected' });
  const stateQuery = calls.find(call => call.statement.includes('WITH latest_per_adjustment AS'));
  assert.ok(stateQuery, 'adjustment processing must recompute the authoritative ledger state');
  assert.match(stateQuery.statement,
    /EXISTS \([\s\S]*?WHERE action = 'chargeback' AND status = 'approved'/);
  assert.doesNotMatch(stateQuery.statement, /status <> 'reversed'/,
    'rejected chargebacks must not be treated as an active dispute');
});

test('adjustment webhook takes the transaction lock before writing adjustment evidence', async () => {
  const { pool, calls } = makePool();
  await sendAdjustment(pool, { action: 'refund', status: 'pending_approval', type: 'full' });
  const lockIndex = calls.findIndex(call => call.statement.includes("paddle-transaction:"));
  const insertIndex = calls.findIndex(call => call.statement.includes('INSERT INTO paddle_adjustment_events'));
  assert.ok(lockIndex >= 0 && insertIndex > lockIndex,
    'adjustment evidence must be serialized by transaction before it is applied');
});

test('chargebacks revoke lifetime Premium and chargeback reversals restore it', async () => {
  const chargeback = makePool({ ledgerStatus: 'active', chargeback: true });
  const revoked = await sendAdjustment(chargeback.pool, { action: 'chargeback', status: 'approved' });
  assert.equal(revoked.premiumRevoked, true);
  assert.ok(chargeback.calls.some(call => call.statement.includes('UPDATE users')));

  const reversal = makePool({
    ledgerStatus: 'revoked',
    revokeReason: 'paddle_chargeback',
    chargeback: false
  });
  const restored = await sendAdjustment(reversal.pool, { action: 'chargeback_reverse', status: 'approved' });
  assert.equal(restored.entitlementChanged, true);
  assert.equal(restored.premiumRevoked, false);
  const update = reversal.calls.find(call => call.statement.includes('UPDATE paddle_lifetime_entitlements'));
  assert.deepEqual(update.params, [transactionId, userId, 'active', null]);
});

test('one approved chargeback reversal cannot clear another active chargeback', async () => {
  const { pool, calls } = makePool({
    ledgerStatus: 'revoked',
    revokeReason: 'paddle_chargeback',
    chargeback: true
  });
  const result = await sendAdjustment(pool, { action: 'chargeback_reverse', status: 'approved' });
  assert.equal(result.entitlementChanged, false);
  assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_lifetime_entitlements')), false);
});

test('a rejected chargeback reversal cannot restore lifetime Premium', async () => {
  const { pool, calls } = makePool({
    ledgerStatus: 'revoked',
    revokeReason: 'paddle_chargeback',
    chargeback: false
  });
  const result = await sendAdjustment(pool, { action: 'chargeback_reverse', status: 'rejected' });
  assert.equal(result.entitlementChanged, false);
  assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_lifetime_entitlements')), false);
});

test('a chargeback reversal cannot restore access while a full approved refund remains active', async () => {
  const { pool, calls } = makePool({
    ledgerStatus: 'revoked',
    revokeReason: 'paddle_chargeback',
    fullRefund: true,
    chargeback: false
  });
  const result = await sendAdjustment(pool, { action: 'chargeback_reverse', status: 'approved' });
  assert.equal(result.premiumRevoked, true);
  const update = calls.find(call => call.statement.includes('UPDATE paddle_lifetime_entitlements'));
  assert.deepEqual(update.params, [transactionId, userId, 'revoked', 'paddle_full_refund']);
});

test('adjustment evidence is processed even when unrelated customer metadata is malformed', async () => {
  const { pool, calls } = makePool({ ledgerStatus: 'active', fullRefund: true });
  const result = await processPaddleEvent(pool, {
    eventId: 'evt_malformed_customer_adjustment',
    eventType: 'adjustment.updated',
    occurredAt: '2026-11-03T10:00:00Z',
    data: {
      id: 'adj_0123456789abcdef01234567',
      transactionId,
      customerId: 'not-a-paddle-customer',
      action: 'refund',
      type: 'full',
      status: 'approved'
    }
  });
  assert.equal(result.premiumRevoked, true);
  assert.ok(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_events')));
});

test('transaction completion reconciles an approved refund delivered earlier', async () => {
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_lifetime_test';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes("SET transaction_id = $1, status = 'completed'")) {
        return { rowCount: 1, rows: [{ user_id: userId }] };
      }
      if (statement.includes('WITH latest_per_adjustment AS')) {
        return { rowCount: 1, rows: [{ full_refund_active: true, chargeback_active: false }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_transaction_after_refund',
      eventType: 'transaction.completed',
      data: {
        id: transactionId,
        customerId: 'ctm_0123456789abcdef0123456789',
        customData: {
          userId,
          plan: 'lifetime',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        items: [{ price: { id: 'pri_lifetime_test' } }],
        details: { totals: { total: '1290' } },
        currencyCode: 'USD'
      }
    });
    assert.equal(result.handled, true);
    const transactionLedger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(transactionLedger, 'every completed Paddle transaction must be retained independently of the checkout pointer');
    assert.deepEqual(transactionLedger.params.slice(0, 5), [
      'evt_transaction_after_refund', transactionId, userId, 'lifetime', 'completed'
    ]);
    assert.deepEqual(transactionLedger.params.slice(5, 7), ['1290', 'USD']);
    const transactionLockIndex = calls.findIndex(call => call.statement.includes("paddle-transaction:"));
    const userLockIndex = calls.findIndex(call => call.statement.includes("gift-safety-user:"));
    assert.ok(transactionLockIndex >= 0 && userLockIndex > transactionLockIndex,
      'transaction.completed must acquire the same transaction lock before the user lock');
    const revoke = calls.find(call => call.statement.includes('UPDATE paddle_lifetime_entitlements'));
    assert.deepEqual(revoke.params, [transactionId, 'paddle_full_refund', userId]);
    assert.ok(calls.some(call =>
      call.statement.includes('UPDATE users') && call.statement.includes('premium_lifetime = EXISTS')
    ), 'the prior approved refund must be applied before the new lifetime entitlement is exposed');
    const caseResolution = calls.find(call =>
      call.statement.includes('UPDATE paddle_adjustment_reconciliation_cases')
    );
    assert.ok(caseResolution, 'a previously unmatched adjustment case must be considered after transaction linkage');
    assert.equal(caseResolution.params[1], userId);
    assert.equal(caseResolution.params[2], 'transaction_completed_linked_to_vow_checkout');
    assert.match(caseResolution.statement, /reason_code = 'transaction_owner_unlinked'/);
    assert.match(caseResolution.statement, /COUNT\(DISTINCT \(user_id, plan\)\)[\s\S]*?\) = 1/);
    assert.match(caseResolution.statement, /linked_attempt\.user_id = \$2/);
    assert.match(caseResolution.statement, /linked_transaction\.plan IN \('1month', '3months'\)/,
      'unverified lifetime transactions must not auto-resolve reconciliation without a linked checkout attempt');

  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});

test('unmatched valid adjustments create a durable reconciliation case', async () => {
  const { pool, calls } = makePool({ linkedRowCount: 0 });
  const result = await sendAdjustment(pool, { action: 'refund', status: 'approved', type: 'full' });
  assert.equal(result.reconciliationRequired, true);
  const task = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
  assert.ok(task, 'an unmatched adjustment must remain in a durable manual queue');
  assert.equal(task.params[1], 'transaction_owner_unlinked');
});

test('adjustments for recurring Vow purchases do not touch lifetime entitlement', async () => {
  const { pool, calls } = makePool({ linkedPlan: '3months', linkedStatus: 'completed' });
  const result = await sendAdjustment(pool, { action: 'refund', status: 'approved', type: 'full' });
  assert.equal(result.adjustmentRecorded, true);
  assert.equal(result.entitlementChanged, false);
  assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_lifetime_entitlements')), false);
  assert.equal(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')), false);
});

test('transaction.canceled events are retained even without a matched checkout row', async () => {
  const originalMonthlyPrice = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthly_test';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('UPDATE paddle_checkout_attempts') && statement.includes("status = 'canceled'")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_canceledtransactionhistory',
      eventType: 'transaction.canceled',
      occurredAt: '2026-11-03T10:00:00Z',
      data: { id: transactionId, items: [{ price: { id: 'pri_monthly_test' } }], details: { totals: { total: '990' } }, currency_code: 'GEL' }
    });
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.deepEqual(ledger.params.slice(0, 5), [
      'evt_canceledtransactionhistory', transactionId, null, '1month', 'canceled'
    ]);
    assert.deepEqual(ledger.params.slice(5, 7), ['990', 'GEL']);
  } finally {
    if (originalMonthlyPrice === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalMonthlyPrice;
  }
});

test('malformed adjustment payloads create a durable webhook reconciliation case', async () => {
  const { pool, calls } = makePool();
  const result = await processPaddleEvent(pool, {
    eventId: 'evt_invalidadjustmentpayload',
    eventType: 'adjustment.created',
    occurredAt: '2026-11-03T10:00:00Z',
    data: { id: 'not-an-adjustment', transaction_id: transactionId, action: 'refund', type: 'full', status: 'approved' }
  });
  assert.equal(result.reconciliationRequired, true);
  const task = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
  assert.ok(task, 'invalid adjustment evidence must not disappear after the webhook is acknowledged');
  assert.equal(task.params[1], 'invalid_adjustment_payload');
});

test('malformed adjustment identifiers are acknowledged without changing entitlement', async () => {
  const { pool, calls } = makePool();
  const result = await processPaddleEvent(pool, {
    eventId: 'evt_invalid_adjustment',
    eventType: 'adjustment.created',
    occurredAt: '2026-11-03T10:00:00Z',
    data: { id: 'not-an-adjustment', transaction_id: transactionId, action: 'refund', type: 'full', status: 'approved' }
  });
  assert.equal(result.reconciliationRequired, true);
  assert.equal(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_events')), false);
  assert.equal(calls.some(call => call.statement.includes('UPDATE users')), false);
});
