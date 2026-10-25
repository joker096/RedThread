import test from 'node:test';
import assert from 'node:assert/strict';
import { GIFT_MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS, GIFT_MAX_NEW_REQUESTS_PER_30_DAYS, GIFT_MIN_MATCH_AGE_DAYS, GIFT_MIN_MESSAGES_PER_PERSON, canTransitionGiftOrder, denyGiftFulfilmentAfterSafetyEvent, evaluateGiftRefundEligibility, evaluateGiftConsentWithdrawalEligibility, validateGiftOrderPersistenceState, evaluateGiftFulfilmentEligibility, evaluateGiftRequestEligibility, redactGiftOrderForSender } from './giftDeliveryPolicy.js';

const sender = { accountStatus: 'active', isAdult: true, identityVerified: true, safetyRestricted: false, pendingRequestsToRecipient: 0, newRequestsLast30Days: 0, acceptedGiftsToRecipientLast7Days: 0, accountCreatedAt: '2026-01-01T00:00:00Z' };
const recipient = { id: 'recipient-internal-42', authenticatedUserId: 'recipient-internal-42', accountStatus: 'active', isAdult: true, safetyRestricted: false, giftRequestsEnabled: true };
const relationship = { safetyEvents: [], safetySnapshotAt: new Date().toISOString(), status: 'active_match', ageDays: GIFT_MIN_MATCH_AGE_DAYS, senderMessagesSent: GIFT_MIN_MESSAGES_PER_PERSON, recipientMessagesSent: GIFT_MIN_MESSAGES_PER_PERSON, blocked: false, reported: false, paused: false, safetyRestricted: false };
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
const order = { id: 'internal-order-1', publicReference: 'gift_7f2a', status: 'address_verified', recipientId: recipient.id, consentRecordedAt: '2026-10-20T12:00:00Z', expiresAt: '2026-10-30T12:00:00Z', totalMinorUnits: 2500, currency: 'GEL', fulfilmentAuthorized: false, productName: 'Chocolate box' };
const address = { ownerUserId: recipient.id, verified: true, recipientEntered: true };
const payment = { status: 'authorized', orderId: order.id, amountMinorUnits: 2500, currency: 'GEL' };
test('fulfilment requires recipient acceptance, unexpired request, verified address and matching payment', () => {
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).eligible, true);
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, status: 'awaiting_recipient_consent' }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'verified_address_state_required');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, expiresAt: undefined }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'request_expired');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, expiresAt: '2020-01-01T00:00:00Z' }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString(), now: Date.now() }).reason, 'request_expired');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, consentRecordedAt: undefined }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_consent_record_missing');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, consentRecordedAt: '2026-10-25T12:00:00Z' }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString(), now: Date.now() }).reason, 'recipient_consent_record_missing');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient: { ...recipient, id: 'other' }, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_authorization_failed');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address: { ...address, recipientEntered: false }, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_address_not_verified');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, payment: { ...payment, amountMinorUnits: 1 }, address, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'payment_not_authorized_for_order');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship: { ...relationship, reported: true }, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'relationship_safety_state_unavailable_or_restricted');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship: { ...relationship, status: 'ended_match' }, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'relationship_safety_state_unavailable_or_restricted');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship: { ...relationship, status: undefined }, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'relationship_safety_state_unavailable_or_restricted');
});
test('fulfilment rejects missing, future-dated, and stale safety snapshots', () => {
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship, safetyEvents: [] }).reason, 'missing_context');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date(Date.now() + 60_000).toISOString() }).reason, 'safety_snapshot_stale_or_invalid');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date(Date.now() - 10 * 60_000).toISOString() }).reason, 'safety_snapshot_stale_or_invalid');
});
test('fulfilment requires explicit fresh safety-event state and a safe active sender', () => {
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship }).reason, 'missing_context');
  for (const event of ['block', 'report', 'restriction', 'account_deleted', 'consent_withdrawn']) {
    assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship, safetyEvents: [event], safetySnapshotAt: new Date().toISOString() }).reason, 'safety_event_requires_fulfilment_suspension');
  }
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender: { ...sender, accountStatus: 'deleted' }, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'sender_safety_state_unavailable_or_restricted');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender: { ...sender, identityVerified: false }, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'sender_safety_state_unavailable_or_restricted');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient: { ...recipient, isAdult: false }, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_safety_state_unavailable_or_restricted');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient, address, payment, relationship, safetyEvents: ['unknown'], safetySnapshotAt: new Date().toISOString() }).reason, 'safety_state_unavailable_or_invalid');
});
test('future gift preference opt-out does not revoke an already accepted order; explicit withdrawal does', () => {
  assert.equal(evaluateGiftFulfilmentEligibility({ request: order, sender, recipient: { ...recipient, giftRequestsEnabled: false }, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_consent_and_verified_address');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, consentWithdrawnAt: '2026-10-23T12:00:00Z' }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_consent_withdrawn');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, status: 'cancelled', consentWithdrawnAt: '2026-10-23T12:00:00Z' }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'recipient_consent_withdrawn');
  assert.equal(evaluateGiftFulfilmentEligibility({ request: { ...order, fulfilmentAuthorized: true }, sender, recipient, address, payment, relationship, safetyEvents: [], safetySnapshotAt: new Date().toISOString() }).reason, 'fulfilment_already_authorized');
});
test('state transitions enforce actors, consent, persisted states, and terminal states', () => {
  assert.equal(canTransitionGiftOrder({ from: 'draft', to: 'awaiting_recipient_consent', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'awaiting_recipient_consent', to: 'recipient_accepted', actor: 'sender', recipientConsentRecorded: true }), false);
  assert.equal(canTransitionGiftOrder({ from: 'awaiting_recipient_consent', to: 'recipient_accepted', actor: 'recipient' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'awaiting_recipient_consent', to: 'recipient_accepted', actor: 'recipient', recipientConsentRecorded: true }), true);
  assert.equal(canTransitionGiftOrder({ from: 'recipient_accepted', to: 'declined', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'recipient_accepted', to: 'declined', actor: 'recipient' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'address_verified', to: 'fulfilment_authorized', actor: 'system', recipientConsentRecorded: true, addressVerified: true }), true);
  assert.equal(canTransitionGiftOrder({ from: 'address_verified', to: 'fulfilment_authorized', actor: 'sender', recipientConsentRecorded: true, addressVerified: true }), false);
  assert.equal(canTransitionGiftOrder({ from: 'address_verified', to: 'fulfilment_authorized', actor: 'system', recipientConsentRecorded: false, addressVerified: true }), false);
  assert.equal(canTransitionGiftOrder({ from: 'fulfilment_authorized', to: 'dispatched', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'fulfilment_authorized', to: 'dispatched', actor: 'trusted_delivery_service' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'fulfilment_authorized', to: 'dispatched', actor: 'delivery_partner' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'fulfilment_authorized', to: 'delivery_failed', actor: 'delivery_partner' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'delivered', to: 'cancelled', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'delivery_failed', to: 'recipient_accepted', actor: 'recipient', recipientConsentRecorded: true }), false);
  assert.equal(canTransitionGiftOrder({ from: 'delivery_failed', to: 'refund_pending', actor: 'system' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'delivery_failed', to: 'refund_pending', actor: 'sender' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'refund_pending', to: 'refunded', actor: 'trusted_payment_service' }), false);
  assert.equal(canTransitionGiftOrder({ from: 'refund_pending', to: 'refunded', actor: 'payment_service' }), true);
  assert.equal(canTransitionGiftOrder({ from: 'declined', to: 'recipient_accepted', actor: 'recipient', recipientConsentRecorded: true }), false);
  assert.equal(canTransitionGiftOrder({ from: 'expired', to: 'recipient_accepted', actor: 'recipient', recipientConsentRecorded: true }), false);
});
test('sender projection never exposes address, phone, email or coordinates', () => {
  const view = redactGiftOrderForSender({ ...order, recipientAddress: 'secret street', recipientPhone: '+9950000', recipientEmail: 'secret@example.com', recipientCoordinates: { lat: 1, lon: 2 } });
  assert.deepEqual(view, { id: 'gift_7f2a', status: 'address_verified', productName: 'Chocolate box', totalMinorUnits: 2500, currency: 'GEL', estimatedDeliveryWindow: null });
  assert.equal(JSON.stringify(view).includes('secret street'), false);
  assert.equal(JSON.stringify(view).includes('+9950000'), false);
  assert.equal(redactGiftOrderForSender({ publicReference: 'gift_safe', status: 'reported' }).status, 'not_available');
  assert.equal(redactGiftOrderForSender({ publicReference: 'gift_safe', status: 'blocked' }).status, 'not_available');
});
test('consent withdrawal is allowed only before fulfilment and inactive payment states', () => {
  const eligible = { status: 'recipient_accepted', paymentStatus: 'not_started' };
  assert.deepEqual(evaluateGiftConsentWithdrawalEligibility(eligible), {
    eligible: true, reason: 'consent_withdrawal_allowed', fulfilmentAuthorized: false
  });
  assert.equal(evaluateGiftConsentWithdrawalEligibility({ ...eligible, status: 'address_verified', paymentStatus: 'voided' }).eligible, true);
  for (const status of ['awaiting_recipient_consent', 'fulfilment_authorized', 'dispatched', 'delivered', 'cancelled', 'declined', 'reported']) {
    assert.equal(evaluateGiftConsentWithdrawalEligibility({ ...eligible, status }).eligible, false, status);
  }
  for (const paymentStatus of ['authorization_pending', 'authorized', 'captured', 'refund_pending', 'refunded']) {
    assert.equal(evaluateGiftConsentWithdrawalEligibility({ ...eligible, paymentStatus }).eligible, false, paymentStatus);
  }
  assert.equal(evaluateGiftConsentWithdrawalEligibility({ ...eligible, consentWithdrawnAt: '2026-10-24T12:00:00Z' }).eligible, false);
  assert.equal(evaluateGiftConsentWithdrawalEligibility({ ...eligible, dispatchedAt: '2026-10-24T12:00:00Z' }).eligible, false);
  assert.equal(evaluateGiftConsentWithdrawalEligibility().eligible, false);
});
test('persisted order and payment states must satisfy the migration invariants', () => {
  const base = { status: 'awaiting_recipient_consent', paymentStatus: 'not_started' };
  assert.deepEqual(validateGiftOrderPersistenceState(base), { valid: true, reason: 'persistence_state_consistent' });
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'draft' }).reason, 'unknown_persisted_state');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'recipient_accepted' }).reason, 'recipient_consent_required');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'address_verified', recipientConsentAt: '2026-10-20T12:00:00Z' }).reason, 'verified_address_required');
  const verified = { ...base, status: 'address_verified', recipientConsentAt: '2026-10-20T12:00:00Z', addressVaultRef: 'vault_ref_123', addressVerifiedAt: '2026-10-20T12:01:00Z' };
  assert.deepEqual(validateGiftOrderPersistenceState(verified), { valid: true, reason: 'persistence_state_consistent' });
  assert.equal(validateGiftOrderPersistenceState({ ...verified, status: 'fulfilment_authorized' }).reason, 'fulfilment_payment_authorization_required');
  assert.equal(validateGiftOrderPersistenceState({ ...verified, status: 'dispatched', paymentStatus: 'authorized', fulfilmentAuthorizedAt: '2026-10-20T12:02:00Z' }).reason, 'dispatch_timestamp_required');
  assert.equal(validateGiftOrderPersistenceState({ ...verified, status: 'delivered', paymentStatus: 'captured', fulfilmentAuthorizedAt: '2026-10-20T12:02:00Z', dispatchedAt: '2026-10-20T12:03:00Z' }).reason, 'delivery_timestamp_required');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'refunded', paymentStatus: 'captured' }).reason, 'refunded_payment_state_required');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'refund_pending', paymentStatus: 'captured' }).reason, 'pending_refund_payment_state_required');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'declined', paymentStatus: 'captured' }).reason, 'declined_order_payment_must_be_inactive');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'cancelled', paymentStatus: 'captured' }).reason, 'cancelled_order_payment_must_be_voided_or_refunded');
  assert.deepEqual(validateGiftOrderPersistenceState({ ...base, status: 'cancelled', paymentStatus: 'voided' }), { valid: true, reason: 'persistence_state_consistent' });
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'cancelled', paymentStatus: 'refund_pending' }).reason, 'cancelled_order_payment_must_be_voided_or_refunded');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'expired', paymentStatus: 'authorization_pending' }).reason, 'expired_order_payment_requires_reconciliation');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'expired', paymentStatus: 'authorized' }).reason, 'expired_order_payment_requires_reconciliation');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'expired', paymentStatus: 'captured' }).reason, 'expired_order_payment_requires_reconciliation');
  assert.equal(validateGiftOrderPersistenceState({ ...base, status: 'expired', paymentStatus: 'refund_pending' }).reason, 'expired_order_payment_requires_reconciliation');
  assert.deepEqual(validateGiftOrderPersistenceState({ ...base, status: 'expired', paymentStatus: 'voided' }), { valid: true, reason: 'persistence_state_consistent' });
});
test('refund policy is fail-closed, state-bound, amount-matched and idempotency-keyed', () => {
  const refundRequest = { ...order, status: 'delivery_failed' };
  const capturedPayment = { ...payment, status: 'captured' };
  const key = 'gift-refund:order-123456';
  assert.equal(evaluateGiftRefundEligibility().reason, 'missing_refund_context');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment: capturedPayment, actor: 'sender', reason: 'delivery failed', idempotencyKey: key }).reason, 'refund_actor_not_authorized');
  assert.equal(evaluateGiftRefundEligibility({ request: { ...refundRequest, status: 'dispatched' }, payment: capturedPayment, actor: 'system', reason: 'delivery failed', idempotencyKey: key }).reason, 'order_not_refundable_in_current_state');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment, actor: 'system', reason: 'delivery failed', idempotencyKey: key }).reason, 'payment_not_captured');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment: { ...capturedPayment, status: 'settled' }, actor: 'system', reason: 'delivery failed', idempotencyKey: key }).reason, 'payment_not_captured');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment: { ...capturedPayment, amountMinorUnits: 1 }, actor: 'system', reason: 'delivery failed', idempotencyKey: key }).reason, 'payment_order_mismatch');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment: capturedPayment, actor: 'system', reason: 'delivery failed', idempotencyKey: 'short' }).reason, 'invalid_refund_idempotency_key');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment: capturedPayment, actor: 'system', reason: { text: 'delivery failed' }, idempotencyKey: key }).reason, 'invalid_refund_reason');
  assert.equal(evaluateGiftRefundEligibility({ request: { ...refundRequest, totalMinorUnits: Number.MAX_SAFE_INTEGER + 1 }, payment: { ...capturedPayment, amountMinorUnits: Number.MAX_SAFE_INTEGER + 1 }, actor: 'system', reason: 'delivery failed', idempotencyKey: key }).reason, 'invalid_refund_amount');
  assert.equal(evaluateGiftRefundEligibility({ request: refundRequest, payment: capturedPayment, actor: 'system', reason: 'delivery failed', idempotencyKey: key, alreadyRefunded: true }).reason, 'refund_already_completed');
  assert.deepEqual(evaluateGiftRefundEligibility({ request: refundRequest, payment: capturedPayment, actor: 'moderator', reason: 'delivery failed', idempotencyKey: key }), {
    eligible: true, reason: 'refund_allowed_pending_idempotent_payment_service', fulfilmentAuthorized: false, refundAmountMinorUnits: 2500, currency: 'GEL'
  });
});
test('block, report and consent withdrawal suspend fulfilment unless already terminal', () => {
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'recipient_accepted', safetyEvent: 'block' }).suspend, true);
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'dispatched', safetyEvent: 'report' }).suspend, true);
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'delivered', safetyEvent: 'report' }).suspend, false);
  assert.deepEqual(denyGiftFulfilmentAfterSafetyEvent({ status: 'blocked', safetyEvent: 'block' }), { suspend: false, reason: 'order_already_terminal' });
  assert.equal(denyGiftFulfilmentAfterSafetyEvent({ status: 'recipient_accepted', safetyEvent: 'unknown' }).suspend, false);
});
