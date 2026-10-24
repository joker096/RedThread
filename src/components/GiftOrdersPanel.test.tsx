import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGiftOrders } from './GiftOrdersPanel.tsx';

const validOrder = {
  publicReference: 'gift_0123456789abcdef0123456789abcdef',
  productName: 'Sealed chocolates',
  productCategory: 'chocolate',
  totalMinorUnits: 2500,
  currency: 'USD',
  status: 'awaiting_recipient_consent',
  createdAt: '2026-10-24T12:00:00.000Z',
  myRole: 'recipient' as const
};

test('gift order list accepts only privacy-safe order projection records', () => {
  const responseOrder = { ...validOrder, address: 'PRIVATE ADDRESS', phone: '+1-555-0100', unexpectedInternalField: 'must not reach component state' };
  assert.deepEqual(normalizeGiftOrders({ orders: [responseOrder] }), [validOrder]);
});

test('gift order list fails closed for malformed payloads and rows', () => {
  assert.deepEqual(normalizeGiftOrders(null), []);
  assert.deepEqual(normalizeGiftOrders({}), []);
  assert.deepEqual(normalizeGiftOrders({ orders: 'not-an-array' }), []);
  assert.deepEqual(normalizeGiftOrders({ orders: [null, {}, { ...validOrder, myRole: 'admin' }, { ...validOrder, totalMinorUnits: '2500' }] }), []);
});

test('gift order list is capped at the API maximum of 50 records', () => {
  const orders = Array.from({ length: 60 }, (_, index) => ({
    ...validOrder,
    publicReference: `gift_${String(index).padStart(32, '0')}`
  }));
  assert.equal(normalizeGiftOrders({ orders }).length, 50);
});
