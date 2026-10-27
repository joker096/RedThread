import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGiftCatalog, normalizeGiftMatches } from './GiftCatalogPanel.tsx';

const match = {
  id: 'a5e4a6a0-2a5e-4a22-9a7d-01bcd2345678',
  displayName: 'A match'
};
const item = {
  id: 'b5e4a6a0-2a5e-4a22-9a7d-01bcd2345678',
  category: 'chocolate',
  displayName: 'Sealed chocolates',
  itemPriceMinorUnits: 2500,
  deliveryFeeMinorUnits: 300,
  totalMinorUnits: 2800,
  currency: 'GEL'
};

test('gift match list normalizes safe display fields and rejects duplicates', () => {
  assert.deepEqual(normalizeGiftMatches({ matches: [
    { ...match, country: 'private location', address: 'must be discarded' },
    { ...match, displayName: 'duplicate' },
    { ...match, id: 'not-a-uuid' },
    null
  ] }), [match]);
});

test('gift catalog normalizes only approved display projection fields', () => {
  assert.deepEqual(normalizeGiftCatalog({ items: [
    { ...item, recipientCity: 'private city', address: 'private address', phone: '+995000000' },
    { ...item, id: 'c5e4a6a0-2a5e-4a22-9a7d-01bcd2345678', displayName: 'Flowers', category: 'flowers', itemPriceMinorUnits: 5000, deliveryFeeMinorUnits: 0, totalMinorUnits: 5000 }
  ] }), [
    item,
    { id: 'c5e4a6a0-2a5e-4a22-9a7d-01bcd2345678', category: 'flowers', displayName: 'Flowers', itemPriceMinorUnits: 5000, deliveryFeeMinorUnits: 0, totalMinorUnits: 5000, currency: 'GEL' }
  ]);
});

test('gift catalog fails closed for malformed IDs, currency, category, and inconsistent totals', () => {
  assert.deepEqual(normalizeGiftCatalog(null), []);
  assert.deepEqual(normalizeGiftCatalog({ items: 'not-an-array' }), []);
  assert.deepEqual(normalizeGiftCatalog({ items: [
    { ...item, id: 'x' },
    { ...item, currency: 'gel' },
    { ...item, category: 'gift_card' },
    { ...item, totalMinorUnits: 1 },
    { ...item, deliveryFeeMinorUnits: -1 },
    { ...item, itemPriceMinorUnits: Number.MAX_SAFE_INTEGER }
  ] }), []);
});

test('gift catalog list caps item count and uses case-insensitive UUID deduplication', () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    ...item,
    id: index === 0 ? item.id : 'b5e4a6a0-2a5e-4a22-9a7d-' + String(index).padStart(12, '0')
  })).map((entry, index) => ({ ...entry, id: index === 1 ? item.id.toUpperCase() : entry.id }));
  const normalized = normalizeGiftCatalog({ items });
  assert.equal(normalized.length, 50);
  assert.equal(normalized.filter(entry => entry.id === item.id).length, 1);
});
