import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGiftOrderStatus } from './giftOrderStatusProjection.js';

const now = Date.parse('2026-10-30T12:00:00.000Z');

function pending(overrides = {}) {
  return {
    status: 'awaiting_recipient_consent',
    myRole: 'recipient',
    expiresAt: '2026-10-31T12:00:00.000Z',
    recipientRequestsDisabledAt: null,
    paymentStatus: 'not_started',
    ...overrides
  };
}

test('recipient opt-out closes pending consent UI regardless of payment reconciliation state', () => {
  assert.equal(projectGiftOrderStatus(pending({
    recipientRequestsDisabledAt: '2026-10-30T11:00:00.000Z',
    paymentStatus: 'authorization_pending'
  }), now), 'not_available');
  assert.equal(projectGiftOrderStatus(pending({
    myRole: 'sender',
    recipientRequestsDisabledAt: '2026-10-30T11:00:00.000Z',
    paymentStatus: 'captured'
  }), now), 'not_available');
});

test('expired pending requests are never projected as actionable while payment is unresolved', () => {
  assert.equal(projectGiftOrderStatus(pending({
    expiresAt: '2026-10-30T11:59:59.000Z',
    paymentStatus: 'authorization_pending'
  }), now), 'expired');
  assert.equal(projectGiftOrderStatus(pending({
    myRole: 'sender',
    expiresAt: '2026-10-30T11:59:59.000Z',
    paymentStatus: 'captured'
  }), now), 'not_available');
});

test('active pending requests remain actionable only with a valid future expiry', () => {
  assert.equal(projectGiftOrderStatus(pending(), now), 'awaiting_recipient_consent');
  assert.equal(projectGiftOrderStatus(pending({ expiresAt: 'not-a-date' }), now), 'not_available');
  assert.equal(projectGiftOrderStatus(pending({ expiresAt: null }), now), 'not_available');
});

test('terminal sender states remain privacy-safe and accepted orders are not changed by future opt-out', () => {
  assert.equal(projectGiftOrderStatus({ status: 'declined', myRole: 'sender' }, now), 'not_available');
  assert.equal(projectGiftOrderStatus({ status: 'declined', myRole: 'recipient' }, now), 'declined');
  assert.equal(projectGiftOrderStatus({
    status: 'recipient_accepted',
    myRole: 'recipient',
    recipientRequestsDisabledAt: '2026-10-30T11:00:00.000Z'
  }, now), 'recipient_accepted');
  assert.equal(projectGiftOrderStatus({ status: 'awaiting_recipient_consent', myRole: 'unknown' }, now), 'not_available');
});
