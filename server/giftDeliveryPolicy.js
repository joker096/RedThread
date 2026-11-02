export const GIFT_MIN_MATCH_AGE_DAYS = 3;
export const GIFT_MIN_MESSAGES_PER_PERSON = 3;
export const GIFT_MAX_NEW_REQUESTS_PER_30_DAYS = 3;
export const GIFT_MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS = 1;
export const GIFT_SAFETY_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

const ALLOWED_GIFT_CATEGORIES = new Set(['flowers', 'chocolate', 'confectionery', 'book', 'approved_gift']);
const BLOCKED_GIFT_CATEGORIES = new Set(['cash', 'gift_card', 'alcohol', 'tobacco', 'nicotine', 'drug', 'medication', 'weapon', 'adult_item', 'crypto', 'gambling', 'unreviewed_food', 'custom_item']);

export function evaluateGiftRequestEligibility({ sender, recipient, relationship, product, delivery, now = Date.now() } = {}) {
  if (!sender || !recipient || !relationship || !product || !delivery) return deny('missing_context');
  if (!Number.isFinite(now)) return deny('invalid_validation_clock');
  const safetySnapshotAt = relationship.safetySnapshotAt;
  if (typeof safetySnapshotAt !== 'string' || safetySnapshotAt.trim().length === 0) return deny('safety_snapshot_stale_or_invalid');
  const safetySnapshotTime = Date.parse(safetySnapshotAt);
  if (!Number.isFinite(safetySnapshotTime) || safetySnapshotTime > now || now - safetySnapshotTime > GIFT_SAFETY_SNAPSHOT_MAX_AGE_MS) return deny('safety_snapshot_stale_or_invalid');
  if (sender.accountStatus !== 'active' || recipient.accountStatus !== 'active') return deny('account_ineligible');
  if (sender.isAdult !== true || recipient.isAdult !== true) return deny('adult_accounts_required');
  if (sender.identityVerified !== true || sender.safetyRestricted !== false || recipient.safetyRestricted !== false) return deny('verification_or_safety_gate_failed');
  if (relationship.status !== 'active_match' || relationship.blocked !== false || relationship.reported !== false || relationship.paused !== false || relationship.safetyRestricted !== false) return deny('relationship_safety_state_unavailable_or_restricted');
  if (!Number.isInteger(relationship.ageDays) || relationship.ageDays < GIFT_MIN_MATCH_AGE_DAYS) return deny('match_too_new');
  if (!Number.isInteger(relationship.senderMessagesSent) || !Number.isInteger(relationship.recipientMessagesSent) || relationship.senderMessagesSent < GIFT_MIN_MESSAGES_PER_PERSON || relationship.recipientMessagesSent < GIFT_MIN_MESSAGES_PER_PERSON) return deny('insufficient_mutual_conversation');
  if (recipient.giftRequestsEnabled !== true) return deny('recipient_gift_requests_disabled');
  if (sender.recipientBlocked === true || recipient.senderBlocked === true) return deny('blocked');
  if (sender.pendingRequestsToRecipient !== 0) return deny('pending_request_exists');
  if (!Number.isInteger(sender.newRequestsLast30Days) || sender.newRequestsLast30Days < 0 || sender.newRequestsLast30Days >= GIFT_MAX_NEW_REQUESTS_PER_30_DAYS) return deny('sender_request_rate_limit');
  if (!Number.isInteger(sender.acceptedGiftsToRecipientLast7Days) || sender.acceptedGiftsToRecipientLast7Days < 0 || sender.acceptedGiftsToRecipientLast7Days >= GIFT_MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS) return deny('recipient_gift_rate_limit');
  if (typeof product.category !== 'string' || BLOCKED_GIFT_CATEGORIES.has(product.category) || !ALLOWED_GIFT_CATEGORIES.has(product.category)) return deny('gift_category_not_allowed');
  if (product.catalogApproved !== true || product.supplierVerified !== true || product.available !== true) return deny('product_or_supplier_not_approved');
  if (!Number.isSafeInteger(product.totalMinorUnits) || product.totalMinorUnits <= 0 || typeof product.currency !== 'string' || !/^[A-Z]{3}$/.test(product.currency)) return deny('invalid_total_price');
  if (delivery.coverageVerified !== true || delivery.countrySupported !== true || delivery.regionAllowed !== true) return deny('delivery_region_unavailable');
  if (typeof delivery.partnerId !== 'string' || delivery.partnerId.length < 1) return deny('delivery_partner_missing');
  if (sender.accountCreatedAt != null && (typeof sender.accountCreatedAt !== 'string' || sender.accountCreatedAt.trim().length === 0 || !Number.isFinite(Date.parse(sender.accountCreatedAt)) || Date.parse(sender.accountCreatedAt) > now)) return deny('invalid_sender_account_age');
  return { eligible: true, reason: 'request_allowed_pending_recipient_consent', fulfilmentAuthorized: false };
}

export function evaluateGiftFulfilmentEligibility({ request, sender, recipient, address, payment, relationship, safetyEvents, safetySnapshotAt, now = Date.now() } = {}) {
  if (!request || !sender || !recipient || !address || !payment || !relationship || !Array.isArray(safetyEvents) || !safetySnapshotAt) return deny('missing_context');
  if (!Number.isFinite(now)) return deny('invalid_validation_clock');
  if (typeof safetySnapshotAt !== 'string' || safetySnapshotAt.trim().length === 0) return deny('safety_snapshot_stale_or_invalid');
  const snapshotTime = Date.parse(safetySnapshotAt);
  if (!Number.isFinite(snapshotTime) || snapshotTime > now || now - snapshotTime > GIFT_SAFETY_SNAPSHOT_MAX_AGE_MS) return deny('safety_snapshot_stale_or_invalid');
  if (safetyEvents.some((event) => !['block', 'report', 'restriction', 'account_deleted', 'consent_withdrawn'].includes(event))) return deny('safety_state_unavailable_or_invalid');
  if (safetyEvents.length > 0) return deny('safety_event_requires_fulfilment_suspension');
  if (sender.accountStatus !== 'active' || sender.isAdult !== true || sender.identityVerified !== true || sender.safetyRestricted !== false) return deny('sender_safety_state_unavailable_or_restricted');
  if (request.consentWithdrawnAt != null) return deny('recipient_consent_withdrawn');
  if (request.status !== 'address_verified') return deny('verified_address_state_required');
  // Bind fulfilment authorization to the actual sender as well as the recipient.
  // A valid payment/order tuple must never be paired with another verified account.
  if (request.senderId !== sender.id) return deny('sender_authorization_failed');
  if (request.recipientId !== recipient.id || recipient.authenticatedUserId !== recipient.id) return deny('recipient_authorization_failed');
  if (typeof request.expiresAt !== 'string' || request.expiresAt.trim().length === 0) return deny('request_expired');
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return deny('request_expired');
  if (typeof request.consentRecordedAt !== 'string' || request.consentRecordedAt.trim().length === 0) return deny('recipient_consent_record_missing');
  const consentRecordedAt = Date.parse(request.consentRecordedAt);
  if (!Number.isFinite(consentRecordedAt) || consentRecordedAt > now) return deny('recipient_consent_record_missing');
  if (address.ownerUserId !== recipient.id || address.verified !== true || address.recipientEntered !== true) return deny('recipient_address_not_verified');
  if (relationship.status !== 'active_match' || relationship.blocked !== false || relationship.reported !== false || relationship.paused !== false || relationship.safetyRestricted !== false) return deny('relationship_safety_state_unavailable_or_restricted');
  if (recipient.safetyRestricted !== false || recipient.accountStatus !== 'active' || recipient.isAdult !== true) return deny('recipient_safety_state_unavailable_or_restricted');
  if (typeof request.id !== 'string' || request.id.length === 0 ||
      !Number.isSafeInteger(request.totalMinorUnits) || request.totalMinorUnits <= 0 ||
      typeof request.currency !== 'string' || !/^[A-Z]{3}$/.test(request.currency)) return deny('invalid_order_payment_context');
  if (payment.status !== 'authorized' || payment.orderId !== request.id ||
      !Number.isSafeInteger(payment.amountMinorUnits) || payment.amountMinorUnits !== request.totalMinorUnits ||
      payment.currency !== request.currency) return deny('payment_not_authorized_for_order');
  if (request.fulfilmentAuthorized === true) return deny('fulfilment_already_authorized');
  return { eligible: true, reason: 'recipient_consent_and_verified_address', fulfilmentAuthorized: true };
}

export function redactGiftOrderForSender(order) {
  if (!order || typeof order !== 'object') return null;
  return {
    id: order.publicReference,
    status: ['declined', 'expired', 'cancelled', 'blocked', 'reported'].includes(order.status) ? 'not_available' : order.status,
    productName: order.productName,
    totalMinorUnits: order.totalMinorUnits,
    currency: order.currency,
    estimatedDeliveryWindow: order.estimatedDeliveryWindow ?? null
  };
}

export function canTransitionGiftOrder({ from, to, actor, recipientConsentRecorded = false, addressVerified = false, paymentStatus, recipientRequestsDisabledAt = null, expiresAt = null, addressVaultRef = null, refundFailed = false, safetyEvents, safetySnapshotAt, now = Date.now() } = {}) {
  const transitions = {
    awaiting_recipient_consent: new Set(['recipient_accepted', 'declined', 'expired', 'reported', 'blocked', 'cancelled', 'refund_pending']),
    recipient_accepted: new Set(['address_verified', 'declined', 'reported', 'blocked', 'cancelled']),
    address_verified: new Set(['fulfilment_authorized', 'cancelled', 'reported', 'blocked']),
    fulfilment_authorized: new Set(['dispatched', 'delivery_failed', 'cancelled', 'reported', 'blocked']),
    dispatched: new Set(['delivered', 'delivery_failed', 'reported']),
    delivery_failed: new Set(['refund_pending', 'cancelled', 'reported']),
    declined: new Set([]), expired: new Set([]), cancelled: new Set([]),
    reported: new Set(['cancelled', 'refund_pending']), blocked: new Set(['cancelled', 'refund_pending']), delivered: new Set([]),
    refund_pending: new Set(['refunded', 'blocked', 'reported']), refunded: new Set([])
  };
  // Keep the policy state graph aligned with persisted statuses; `draft` is not a DB state.
  if (!Number.isFinite(now) || !transitions[from]?.has(to)) return false;
  // Terminalize only after payment is known to be inactive; callers must reconcile active payments first.
  if (['declined', 'expired', 'cancelled'].includes(to) && !['not_started', 'voided', 'failed'].includes(paymentStatus)) return false;
  // High-impact transitions require a fresh, explicit safety snapshot; unknown/stale safety state fails closed.
  if (to === 'fulfilment_authorized' || to === 'dispatched') {
    if (typeof safetySnapshotAt !== 'string' || safetySnapshotAt.trim().length === 0) return false;
    const snapshotTime = Date.parse(safetySnapshotAt);
    if (!Array.isArray(safetyEvents) || safetyEvents.some((event) => !['block', 'report', 'restriction', 'account_deleted', 'consent_withdrawn'].includes(event))) return false;
    if (safetyEvents.length > 0 || !Number.isFinite(snapshotTime) || snapshotTime > now || now - snapshotTime > GIFT_SAFETY_SNAPSHOT_MAX_AGE_MS) return false;
  }
  // State transitions must not bypass the payment lifecycle enforced by persistence constraints.
  if (to === 'fulfilment_authorized' && !['authorized', 'captured'].includes(paymentStatus)) return false;
  if (to === 'dispatched' && !['authorized', 'captured'].includes(paymentStatus)) return false;
  // Delivery must not be marked complete while payment state is missing or inactive.
  if (to === 'delivered' && !['authorized', 'captured'].includes(paymentStatus)) return false;
  // Delivery outcomes must retain evidence of recipient consent and a verified address.
  if (['delivered', 'delivery_failed'].includes(to) && (recipientConsentRecorded !== true || addressVerified !== true)) return false;
  if (to === 'delivery_failed' && !['authorized', 'captured'].includes(paymentStatus)) return false;
  if (to === 'refund_pending' && paymentStatus !== 'captured') return false;
  if (to === 'refund_pending' && addressVaultRef != null) return false;
  if (from === 'awaiting_recipient_consent' && to === 'refund_pending') {
    const optOutAt = Date.parse(recipientRequestsDisabledAt);
    const expiryAt = Date.parse(expiresAt);
    const optOutInvalidated = Number.isFinite(optOutAt) && optOutAt <= now;
    const requestExpired = Number.isFinite(expiryAt) && expiryAt <= now;
    if (!optOutInvalidated && !requestExpired) return false;
  }
  if (to === 'refunded' && paymentStatus !== 'refund_pending') return false;
  if (from === 'refund_pending' && ['blocked', 'reported'].includes(to) &&
      (paymentStatus !== 'refund_pending' || refundFailed !== true || !['system', 'moderator'].includes(actor))) return false;

  if (to === 'awaiting_recipient_consent' && actor !== 'sender') return false;
  if (to === 'recipient_accepted' && (actor !== 'recipient' || recipientConsentRecorded !== true)) return false;
  if (to === 'address_verified' && (actor !== 'recipient' || recipientConsentRecorded !== true || addressVerified !== true)) return false;
  if (to === 'fulfilment_authorized' && (actor !== 'system' || recipientConsentRecorded !== true || addressVerified !== true)) return false;
  if (to === 'dispatched' && (recipientConsentRecorded !== true || addressVerified !== true)) return false;
  if (to === 'declined' && actor !== 'recipient') return false;
  if (to === 'expired' && actor !== 'system') return false;
  if (to === 'cancelled' && !['sender', 'recipient', 'moderator', 'system'].includes(actor)) return false;
  if (to === 'blocked' && !['sender', 'recipient', 'moderator', 'system'].includes(actor)) return false;
  if (to === 'reported' && !['sender', 'recipient', 'moderator', 'system'].includes(actor)) return false;
  if ((to === 'dispatched' || to === 'delivered' || to === 'delivery_failed') && actor !== 'delivery_partner') return false;
  if (to === 'refund_pending' && !['system', 'moderator'].includes(actor)) return false;
  if (to === 'refunded' && actor !== 'payment_service') return false;
  return true;
}

export function validateGiftOrderPersistenceState(order = {}, { now = Date.now() } = {}) {
  const validStatuses = new Set([
    'awaiting_recipient_consent', 'recipient_accepted', 'address_verified', 'fulfilment_authorized',
    'dispatched', 'delivered', 'declined', 'expired', 'cancelled', 'blocked', 'reported',
    'delivery_failed', 'refund_pending', 'refunded'
  ]);
  const validPaymentStatuses = new Set(['not_started', 'authorization_pending', 'authorized', 'captured', 'voided', 'refund_pending', 'refunded', 'failed']);
  const hasValidTimestamp = (value) => typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
  const hasNonFutureTimestamp = (value) => hasValidTimestamp(value) && Date.parse(value) <= now;
  const hasNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!Number.isFinite(now)) return { valid: false, reason: 'invalid_validation_clock' };
  if (!validStatuses.has(order.status) || !validPaymentStatuses.has(order.paymentStatus)) return { valid: false, reason: 'unknown_persisted_state' };
  if (order.paymentStatus === 'refunded' && order.status !== 'refunded') return { valid: false, reason: 'refunded_payment_requires_refunded_order_state' };
  if (order.status === 'refunded' && order.paymentStatus !== 'refunded') return { valid: false, reason: 'refunded_payment_state_required' };
  if (order.consentWithdrawnAt != null && ['recipient_accepted', 'address_verified', 'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'].includes(order.status)) return { valid: false, reason: 'consent_withdrawn_order_cannot_progress' };
  const addressVaultAllowedStatuses = ['address_verified', 'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'];
  if (order.addressVaultRef != null && !addressVaultAllowedStatuses.includes(order.status)) return { valid: false, reason: 'address_vault_ref_forbidden_in_order_state' };
  if (['recipient_accepted', 'address_verified', 'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'].includes(order.status) && !hasNonFutureTimestamp(order.recipientConsentAt)) return { valid: false, reason: 'recipient_consent_required' };
  if (['address_verified', 'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'].includes(order.status) && (!hasNonEmptyString(order.addressVaultRef) || !hasNonFutureTimestamp(order.addressVerifiedAt))) return { valid: false, reason: 'verified_address_required' };
  if (['fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'].includes(order.status) && (!hasNonFutureTimestamp(order.fulfilmentAuthorizedAt) || !['authorized', 'captured'].includes(order.paymentStatus))) return { valid: false, reason: 'fulfilment_payment_authorization_required' };
  if (order.status === 'dispatched' && !hasNonFutureTimestamp(order.dispatchedAt)) return { valid: false, reason: 'dispatch_timestamp_required' };
  if (order.status === 'delivered' && !hasNonFutureTimestamp(order.deliveredAt)) return { valid: false, reason: 'delivery_timestamp_required' };
  if (order.status === 'refund_pending' && order.paymentStatus !== 'refund_pending') return { valid: false, reason: 'pending_refund_payment_state_required' };
  if (order.status === 'declined' && order.paymentStatus !== 'not_started' && order.paymentStatus !== 'voided' && order.paymentStatus !== 'failed') return { valid: false, reason: 'declined_order_payment_must_be_inactive' };
  if (order.status === 'expired' && ['authorization_pending', 'authorized', 'captured', 'refund_pending'].includes(order.paymentStatus)) return { valid: false, reason: 'expired_order_payment_requires_reconciliation' };
  if (order.status === 'cancelled' && ['authorization_pending', 'authorized', 'captured', 'refund_pending'].includes(order.paymentStatus)) return { valid: false, reason: 'cancelled_order_payment_must_be_voided_or_refunded' };
  return { valid: true, reason: 'persistence_state_consistent' };
}

export function evaluateGiftConsentWithdrawalEligibility(order = {}) {
  if (!order || typeof order !== 'object') return deny('missing_withdrawal_context');
  if (order.consentWithdrawnAt != null) return deny('gift_order_not_withdrawable');
  if (!['recipient_accepted', 'address_verified'].includes(order.status)) return deny('gift_order_not_withdrawable');
  if (order.dispatchedAt != null) return deny('gift_order_not_withdrawable');
  if (!['not_started', 'failed', 'voided'].includes(order.paymentStatus)) return deny('gift_order_not_withdrawable');
  return { eligible: true, reason: 'consent_withdrawal_allowed', fulfilmentAuthorized: false };
}

export function evaluateGiftRefundEligibility({ request, payment, actor, reason, idempotencyKey, alreadyRefunded = false, now = Date.now() } = {}) {
  if (!request || !payment || !actor || !reason || !idempotencyKey) return deny('missing_refund_context');
  if (!Number.isFinite(now)) return deny('invalid_refund_clock');
  if (!['system', 'moderator'].includes(actor)) return deny('refund_actor_not_authorized');
  // Start a refund only from a captured order that has not entered the pending-refund state.
  // Pending refunds require provider reconciliation, not a fresh refund request.
  if (alreadyRefunded || payment.status === 'refunded' || request.status === 'refunded') return deny('refund_already_completed');
  const recipientRequestsDisabledAt = request.recipientRequestsDisabledAt ?? request.recipient_requests_disabled_at;
  const recipientOptOutAt = Date.parse(recipientRequestsDisabledAt);
  const expiresAt = request.expiresAt ?? request.expires_at;
  const requestExpiryAt = Date.parse(expiresAt);
  const recipientOptedOutPendingRequest =
    request.status === 'awaiting_recipient_consent' &&
    ((Number.isFinite(recipientOptOutAt) && recipientOptOutAt <= now) ||
      (Number.isFinite(requestExpiryAt) && requestExpiryAt <= now));
  if (!['delivery_failed', 'reported', 'blocked'].includes(request.status) &&
      !recipientOptedOutPendingRequest) {
    return deny('order_not_refundable_in_current_state');
  }
  const addressVaultRef = request.addressVaultRef ?? request.address_vault_ref;
  if (addressVaultRef != null) return deny('address_access_must_be_revoked_before_refund');
  if (payment.status !== 'captured') return deny('payment_not_captured');
  if (payment.orderId !== request.id || payment.amountMinorUnits !== request.totalMinorUnits || payment.currency !== request.currency) return deny('payment_order_mismatch');
  if (!Number.isSafeInteger(request.totalMinorUnits) || request.totalMinorUnits <= 0 || typeof request.currency !== 'string' || !/^[A-Z]{3}$/.test(request.currency)) return deny('invalid_refund_amount');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{16,128}$/.test(idempotencyKey)) return deny('invalid_refund_idempotency_key');
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) return deny('invalid_refund_reason');
  return { eligible: true, reason: 'refund_allowed_pending_idempotent_payment_service', fulfilmentAuthorized: false, refundAmountMinorUnits: request.totalMinorUnits, currency: request.currency };
}

export function denyGiftFulfilmentAfterSafetyEvent({ status, safetyEvent } = {}) {
  if (!['block', 'report', 'restriction', 'account_deleted', 'consent_withdrawn'].includes(safetyEvent)) return { suspend: false, reason: 'no_safety_event' };
  if (['delivered', 'declined', 'expired', 'cancelled', 'blocked', 'refunded'].includes(status)) return { suspend: false, reason: 'order_already_terminal' };
  return { suspend: true, reason: 'safety_event_requires_fulfilment_suspension' };
}

function deny(reason) {
  return { eligible: false, reason, fulfilmentAuthorized: false };
}


const SAFE_GIFT_SAFETY_AUDIT_REASONS = new Set([
  'account_deleted',
  'moderator_suspension',
  'account_safety_event'
]);

// Audit metadata must contain only stable internal reason codes, never caller-supplied prose.
export function normalizeGiftSafetyAuditReason(reason) {
  return typeof reason === 'string' && SAFE_GIFT_SAFETY_AUDIT_REASONS.has(reason)
    ? reason
    : 'account_safety_event';
}
