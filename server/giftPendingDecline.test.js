import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPendingRecipientDecline } from './giftOrderCreationService.js';

test('a pending recipient decline blocks a later gift acceptance', async () => {
  let captured;
  const client = {
    async query(sql, values) {
      captured = { sql, values };
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    }
  };
  assert.equal(await hasPendingRecipientDecline(client, 'order-123'), true);
  assert.deepEqual(captured.values, ['order-123']);
  assert.match(captured.sql, /recipient_declined_active_payment/);
  assert.match(captured.sql, /payment_reconciliation_required/);
  assert.match(captured.sql, /metadata->>'reason'/);
  assert.match(captured.sql, /gift_delivery_order_events/);
});

test('a gift remains acceptable only when no decline reconciliation intent exists', async () => {
  const client = { async query() { return { rowCount: 0, rows: [] }; } };
  assert.equal(await hasPendingRecipientDecline(client, 'order-456'), false);
});
