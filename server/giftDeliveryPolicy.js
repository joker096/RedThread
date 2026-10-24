export const GIFT_MIN_MATCH_AGE_DAYS = 3;
export const GIFT_MIN_MESSAGES_PER_PERSON = 3;
export const GIFT_MAX_NEW_REQUESTS_PER_30_DAYS = 3;
export const GIFT_MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS = 1;

const ALLOWED_GIFT_CATEGORIES = new Set(['flowers', 'chocolate', 'confectionery', 'book', 'approved_gift']);
const BLOCKED_GIFT_CATEGORIES = new Set(['cash', 'gift_card', 'alcohol', 'tobacco', 'nicotine', 'drug', 'medication', 'weapon', 'adult_item', 'crypto', 'gambling', 'unreviewed_food', 'custom_item']);

export function evaluateGiftRequestEligibility({ sender, recipient, relationship, product, delivery, now = Date.now() } = {}) {
  if (!sender || !recipient || !relationship || !product || !delivery) return deny('missing_context');
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
  if (sender.accountCreatedAt && (!Number.isFinite(Date.parse(sender.accountCreatedAt)) || Date.parse(sender.accountCreatedAt) > now)) return deny('invalid_sender_account_age');
  return { eligible: true, reason: 'request_allowed_pending_recipient_consent', fulfilmentAuthorized: false };
}

export function evaluateGiftFulfilmentEligibility({ request, sender, recipient, address, payment, relationship, safetyEvents, now = Date.now() } = {}) {
  if (!request || !sender || !recipient || !address || !payment || !relationship || !Array.isArray(safetyEvents)) return deny('missing_context');
  if (safetyEvents.some((event) => !['block', 'report', 'restriction', 'account_deleted', 'consent_withdrawn'].includes(event))) return deny('safety_state_unavailable_or_invalid');
  if (safetyEvents.length > 0) return deny('safety_event_requires_fulfilment_suspension');
  if (sender.accountStatus !== 'active' || sender.safetyRestricted !== false) return deny('sender_safety_state_unavailable_or_restricted');
  if (request.status !== 'recipient_accepted') return deny('recipient_consent_required');
  if (request.recipientId !== recipient.id || recipient.authenticatedUserId !== recipient.id) return deny('recipient_authorization_failed');
  if (!request.expiresAt || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= now) return deny('request_expired');
  const consentRecordedAt = Date.parse(request.consentRecordedAt);
  if (!Number.isFinite(consentRecordedAt) || consentRecordedAt > now) return deny('recipient_consent_record_missing');
  if (request.consentWithdrawnAt != null || recipient.giftRequestsEnabled !== true) return deny('recipient_consent_withdrawn');
  if (address.ownerUserId !== recipient.id || address.verified !== true || address.recipientEntered !== true) return deny('recipient_address_not_verified');
  if (relationship.blocked !== false || relationship.reported !== false || relationship.paused !== false || relationship.safetyRestricted !== false) return deny('relationship_safety_state_unavailable_or_restricted');
  if (recipient.safetyRestricted !== false || recipient.accountStatus !== 'active') return deny('recipient_safety_state_unavailable_or_restricted');
  if (payment.status !== 'authorized' || payment.orderId !== request.id || payment.amountMinorUnits !== request.totalMinorUnits || payment.currency !== request.currency) return deny('payment_not_authorized_for_order');
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

export function canTransitionGiftOrder({ from, to, actor, recipientConsentRecorded = false, addressVerified = false } = {}) {
  const transitions = {
    awaiting_recipient_consent: new Set(['recipient_accepted', 'declined', 'expired', 'reported', 'blocked', 'cancelled']),
    recipient_accepted: new Set(['address_verified', 'declined', 'reported', 'blocked', 'cancelled']),
    address_verified: new Set(['fulfilment_authorized', 'cancelled', 'reported', 'blocked']),
    fulfilment_authorized: new Set(['dispatched', 'delivery_failed', 'cancelled', 'reported', 'blocked']),
    dispatched: new Set(['delivered', 'delivery_failed', 'reported']),
    delivery_failed: new Set(['refund_pending', 'cancelled']),
    declined: new Set([]), expired: new Set([]), cancelled: new Set([]), blocked: new Set([]),
    reported: new Set(['cancelled', 'refund_pending']), delivered: new Set([]),
    refund_pending: new Set(['refunded']), refunded: new Set([])
  };
  // Keep the policy state graph aligned with persisted statuses; `draft` is not a DB state.
  if (!transitions[from]?.has(to)) return false;

  if (to === 'awaiting_recipient_consent' && actor !== 'sender') return false;
  if (to === 'recipient_accepted' && (actor !== 'recipient' || !recipientConsentRecorded)) return false;
  if (to === 'address_verified' && (actor !== 'recipient' || !recipientConsentRecorded || !addressVerified)) return false;
  if (to === 'fulfilment_authorized' && (actor !== 'system' || !recipientConsentRecorded || !addressVerified)) return false;
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

export function denyGiftFulfilmentAfterSafetyEvent({ status, safetyEvent } = {}) {
  if (!['block', 'report', 'restriction', 'account_deleted', 'consent_withdrawn'].includes(safetyEvent)) return { suspend: false, reason: 'no_safety_event' };
  if (['delivered', 'declined', 'expired', 'cancelled', 'blocked', 'refunded'].includes(status)) return { suspend: false, reason: 'order_already_terminal' };
  return { suspend: true, reason: 'safety_event_requires_fulfilment_suspension' };
}

function deny(reason) {
  return { eligible: false, reason, fulfilmentAuthorized: false };
}
