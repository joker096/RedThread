import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGiftOrderCreation } from './giftOrderCreationPolicy.js';

function validContext() {
  return {
    sender: { id: 'sender', accountStatus: 'active', isAdult: true, identityVerified: true, safetyRestricted: false },
    recipient: { id: 'recipient', accountStatus: 'active', isAdult: true, safetyRestricted: false, giftRequestsEnabled: true },
    match: { status: 'active', includesSender: true, includesRecipient: true, ageDays: 5 },
    product: { category: 'chocolate', active: true, approved: true, supplierVerified: true, totalMinorUnits: 2500, currency: 'GEL' },
    delivery: { partnerVerified: true, coverageActive: true, countryCodeMatches: true, cityKeyMatches: true },
    activity: { senderMessages: 4, recipientMessages: 4, pendingRequestsForPair: 0, senderRequestsLast30Days: 0, acceptedGiftsToRecipientLast7Days: 0 },
    safety: { blocked: false, openReport: false },
    idempotency: { valid: true, duplicate: false }
  };
}

test('eligible trusted context remains pending recipient consent and never authorizes payment', () => {
  const result = evaluateGiftOrderCreation(validContext());
  assert.deepEqual(result, {
    eligible: true,
    reason: 'eligible_pending_recipient_consent',
    createsOrder: false,
    paymentAuthorized: false,
    addressAccessGranted: false
  });
});

test('fails closed when identity, consent preference, safety, or regional coverage is missing', () => {
  const cases = [
    c => { c.sender.identityVerified = false; },
    c => { c.recipient.giftRequestsEnabled = false; },
    c => { c.safety.blocked = true; },
    c => { c.safety.openReport = true; },
    c => { c.delivery.cityKeyMatches = false; },
    c => { c.delivery.partnerVerified = false; },
    c => { c.match.status = 'closed'; },
    c => { c.activity.pendingRequestsForPair = 1; },
    c => { c.idempotency.duplicate = true; }
  ];
  for (const mutate of cases) {
    const context = validContext();
    mutate(context);
    const result = evaluateGiftOrderCreation(context);
    assert.equal(result.eligible, false);
    assert.equal(result.createsOrder, false);
    assert.equal(result.paymentAuthorized, false);
    assert.equal(result.addressAccessGranted, false);
  }
});

test('rejects unsafe catalog entries and rate-limit violations', () => {
  const blocked = validContext();
  blocked.product.category = 'gift_card';
  assert.equal(evaluateGiftOrderCreation(blocked).eligible, false);
  const rateLimited = validContext();
  rateLimited.activity.senderRequestsLast30Days = 3;
  assert.equal(evaluateGiftOrderCreation(rateLimited).eligible, false);
});

test('recipient weekly acceptance cap and sender idempotency both fail closed', () => {
  const recipientCapped = validContext();
  recipientCapped.activity.acceptedGiftsToRecipientLast7Days = 1;
  assert.equal(evaluateGiftOrderCreation(recipientCapped).reason, 'recipient_gift_rate_limit');

  const missingIdempotency = validContext();
  missingIdempotency.idempotency.valid = false;
  assert.equal(evaluateGiftOrderCreation(missingIdempotency).reason, 'idempotency_check_failed');

  const duplicateIdempotency = validContext();
  duplicateIdempotency.idempotency.duplicate = true;
  assert.equal(evaluateGiftOrderCreation(duplicateIdempotency).reason, 'idempotency_check_failed');
});

test('missing age or message counts cannot pass eligibility', () => {
  const noAge = validContext();
  delete noAge.match.ageDays;
  assert.equal(evaluateGiftOrderCreation(noAge).eligible, false);
  const noMessages = validContext();
  delete noMessages.activity.senderMessages;
  assert.equal(evaluateGiftOrderCreation(noMessages).eligible, false);
});

test('missing trusted context is denied', () => {
  const result = evaluateGiftOrderCreation({ sender: {} });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'missing_context');
});

test('rejects self-gifting, invalid money values, and unverified suppliers', () => {
  const selfGift = validContext();
  selfGift.recipient.id = selfGift.sender.id;
  assert.equal(evaluateGiftOrderCreation(selfGift).reason, 'invalid_participants');

  const mixedTypeSelfGift = validContext();
  mixedTypeSelfGift.sender.id = 42;
  mixedTypeSelfGift.recipient.id = '42';
  assert.equal(evaluateGiftOrderCreation(mixedTypeSelfGift).reason, 'invalid_participants');

  const zeroPrice = validContext();
  zeroPrice.product.totalMinorUnits = 0;
  assert.equal(evaluateGiftOrderCreation(zeroPrice).reason, 'invalid_total_price');

  const malformedCurrency = validContext();
  malformedCurrency.product.currency = 'gel';
  assert.equal(evaluateGiftOrderCreation(malformedCurrency).reason, 'invalid_total_price');

  const unverifiedSupplier = validContext();
  unverifiedSupplier.product.supplierVerified = false;
  assert.equal(evaluateGiftOrderCreation(unverifiedSupplier).reason, 'product_or_supplier_not_approved');
});
