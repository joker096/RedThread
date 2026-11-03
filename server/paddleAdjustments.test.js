import test from 'node:test';
import assert from 'node:assert/strict';
import { processPaddleEvent } from './paddleBilling.js';

const userId = '00000000-0000-4000-8000-000000000001';
const transactionId = 'txn_0123456789abcdef01234567';

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
    eventId: eventId || 'evt_' + Math.random().toString(36).slice(2, 18).padEnd(26, 'a').slice(0, 26),
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
