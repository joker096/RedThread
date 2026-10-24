import test from 'node:test';
import assert from 'node:assert/strict';
import { GIFT_MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS, GIFT_MAX_NEW_REQUESTS_PER_30_DAYS, GIFT_MIN_MATCH_AGE_DAYS, GIFT_MIN_MESSAGES_PER_PERSON, canTransitionGiftOrder, denyGiftFulfilmentAfterSafetyEvent, evaluateGiftFulfilmentEligibility, evaluateGiftRequestEligibility, redactGiftOrderForSender } from './giftDeliveryPolicy.js';

const sender = { accountStatus: 'active', isAdult: true, identityVerified: true, safetyRestricted: false, pendingRequestsToRecipient: 0, newRequestsLast30Days: 0, acceptedGiftsToRecipientLast7Days: 0, accountCreatedAt: '2026-01-01T00:00:00Z' };
const recipient = { id: 'recipient-internal-42', authenticatedUserId: 'recipient-internal-42', accountStatus: 'active', isAdult: true, safetyRestricted: false, giftRequestsEnabled: true };
const relationship = { status: 'active_match', ageDays: GIFT_MIN_MATCH_AGE_DAYS, senderMessagesSent: GIFT_MIN_MESSAGES_PER_PERSON, recipientMessagesSent: GIFT_MIN_MESSAGES_PER_PERSON, blocked: false, reported: false, paused: false, safetyRestricted: false };
const product = { category: 'chocolate', catalogApproved: true, supplierVerified: true, available: true, totalMinorUnits: 2500, currency: 'GEL' };
const delivery = { coverageVerified: true, countrySupported: true, regionAllowed: true, partnerId: 'partner-ge-1' };
function request(overrides = {}) { return evaluateGiftRequestEligibility({ sender: { ...sender, ...overrides.sender }, recipient: { ...recipient, ...overrides.recipient }, relationship: { ...relationship, ...overrides.relationship }, product: { ...product, ...overrides.product }, delivery: { ...delivery, ...overrides.delivery } }); }

test('valid request remains pending until recipient consent', () => assert.deepEqual(request(), { eligible: true, reason: 'request_allowed_pending_recipient_consent', fulfilmentAuthorized: false }));
test('request fails closed on missing context, identity, consent, safety, or relationship facts', () => {
  assert.equal(evaluateGiftRequestEligibility().reason, 'missing_context');
  assert.equal(request({ sender: { identityVerified: false } }).reason, 'verification_or_safety_gate_failed');
  assert.equal(request({ recipient: { giftRequestsEnabled: false } }).reason, 'recipient_gift_requests_disabled');
  assert.equal(request({ recipient: { safetyRestricted: undefined } }).reason, 'verification_or_safety_gate_failed');
  assert.equal(request({ relationship: { blocked: undefined } }).reason, 'relationship_safety_state_unavailable_or_restricted');
  assert.equal(request({ relationship: { ageDays: 1 } }).reason, 'match_too_new');
  assert.equal(request({ relationship: { recipientMessagesSent: 0 } }).reason, 'insufficient_mutual_conversation');
});
test('rate limits and product restrictions block coercion and unsafe categories', () => {
  assert.equal(request({ sender: { pendingRequestsToRecipient: 1 } }).reason, 'pending_request_exists');
  assert.equal(request({ sender: { newRequestsLast30Days: GIFT_MAX_NEW_REQUESTS_PER_30_DAYS } }).reason, 'sender_request_rate_limit');
  assert.equal(request({ sender: { acceptedGiftsToRecipientLast7Days: GIFT_MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS } }).reason, 'recipient_gift_rate_limit');
  assert.equal(request({ recipient: { senderBlocked: true } }).reason, 'blocked');
  assert.equal(request({ product: { category: 'gift_card' } }).reason, 'gift_category_not_allowed');
  assert.equal(request({ product: { category: 'alcohol' } }).reason, 'gift_category_not_allowed');
  assert.equal(request({ product: { catalogApproved: false } }).reason, 'product_or_supplier_not_approved');
  assert.equal(request({ product: { totalMinorUnits: 0 } }).reason, 'invalid_total_price');
  assert.equal(request({ delivery: { coverageVerified: false } }).reason, 'delivery_region_unavailable');
});
const order = { id: 'internal-order-1', publicReference: 'gift_7f2a', status: 'recipient_accepted', recipientId: recipient.id, consentRecordedAt: '2026-10-20T12:00:00Z', expiresAt: '2026-10-30T12:00:00Z', totalMinorUnits: 2500, currency: 'GEL', fulfilmentAuthorized: false, productName: 'Chocolate box' };
const address = { ownerUserId: recipient.id, verified: true, recipientEntered: true };
const payment = { status: 'authorized', orderId: order.id, amountMinorUnits: 2500, currency: 'GEL' };
test('fulfilment requires recipient acceptance, verified address and matching payment', () => {
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, recipient, address, payment, relationship }).eligible, true);
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, status: 'awaiting_recipient_consent' }, recipient, address, payment, relationship }).reason, 'recipient_consent_required');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, recipient: { ...recipient, id: 'other' }, address, payment, relationship }).reason, 'recipient_authorization_failed');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, recipient, address: { ...address, recipientEntered: false }, payment, relationship }).reason, 'recipient_address_not_verified');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, recipient, address, payment: { ...payment, amountMinorUnits: 1 }, relationship }).reason, 'payment_not_authorized_for_order');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, recipient, address, payment, relationship: { ...relationship, reported: true } }).reason, 'relationship_safety_state_unavailable_or_restricted');
});
test('only recipient can accept; only trusted delivery service can update delivery states', () => {
  assert.equal(canTransitionGiftOrder({ from: 'awaiting_recipient_consent', to: 'recipient_accepted', actor: 'recipient' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'awaiting_recipient_consent', to: 'recipient_accepted', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'address_verified', to: 'fulfilment_authorized', recipientConsentRecorded: true, addressVerified: true }), true);
  assert.equal(canTransitionGiftOrder({ from: 'address_verified', to: 'fulfilment_authorized', recipientConsentRecorded: false, addressVerified: true }), false);
  assert.equal(canTransitionGiftOrder({ from: 'fulfilment_authorized', to: 'dispatched', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'fulfilment_authorized', to: 'dispatched', actor: 'trusted_delivery_service' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'delivered', to: 'cancelled', actor: 'sender' }), false);
});
test('sender projection never exposes address, phone, email or coordinates', () => {
  const view = redactGiftOrderForSender({ ...order, recipientAddress: 'secret street', recipientPhone: '+9950000', recipientEmail: 'secret@example.com', recipientCoordinates: { lat: 1, lon: 2 } });
  assert.deepEqual(view, { id: 'gift_7f2a', status: 'recipient_accepted', productName: 'Chocolate box', totalMinorUnits: 2500, currency: 'GEL', estimatedDeliveryWindow: null });
  assert.equal(JSON.stringify(view).includes('secret street'), false);
  assert.equal(JSON.stringify(view).includes('+9950000'), false);
});
test('block, report and consent withdrawal suspend fulfilment unless already terminal', () => {
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'recipient_accepted', safetyEvent: 'block' }).suspend, true);
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'dispatched', safetyEvent: 'report' }).suspend, true);
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'delivered', safetyEvent: 'report' }).suspend, false);
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'recipient_accepted', safetyEvent: 'unknown' }).suspend, false);
});
