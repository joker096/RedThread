import test from 'node:test';
import assert from 'node:assert/strict';
import { processPaddleEvent } from './paddleBilling.js';

const userId = '00000000-0000-4000-8000-000000000001';
const transactionId = 'txn_0123456789abcdef01234567';
let eventCounter = 0;

function makePool({ ledgerStatus = 'active', revokeReason = null, fullRefund = false, chargeback = false } = {}) {
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
      if (statement.includes('SELECT user_id FROM (')) {
        return { rowCount: 1, rows: [{ user_id: userId }] };
      }
      if (statement.includes('SELECT id, status, premium_lifetime FROM users')) {
        return { rowCount: 1, rows: [{ id: userId, status: 'active', premium_lifetime: true }] };
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

async function sendAdjustment(pool, { eventId, action, status, type = 'partial', eventType = 'adjustment.created' } = {}) {
  return processPaddleEvent(pool, {
    eventId: eventId || 'evt_' + String(++eventCounter).padStart(26, '0'),
    eventType,
    occurredAt: '2026-11-03T10:00:00Z',
    data: {
      id: 'adj_0123456789abcdef01234567',
      transactionId,
      action,
      type,
      status
    }
  });
}

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
        items: [{ price: { id: 'pri_lifetime_test' } }]
      }
    });
    assert.equal(result.handled, true);
    const revoke = calls.find(call => call.statement.includes('UPDATE paddle_lifetime_entitlements'));
    assert.deepEqual(revoke.params, [transactionId, 'paddle_full_refund', userId]);
    assert.ok(calls.some(call =>
      call.statement.includes('UPDATE users') && call.statement.includes('premium_lifetime = EXISTS')
    ), 'the prior approved refund must be applied before the new lifetime entitlement is exposed');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
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
