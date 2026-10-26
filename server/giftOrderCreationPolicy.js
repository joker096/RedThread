const ALLOWED_CATEGORIES = new Set(['flowers', 'chocolate', 'confectionery', 'book', 'approved_gift']);
const MAX_REQUESTS_PER_30_DAYS = 3;
const MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS = 1;
const MIN_MATCH_AGE_DAYS = 3;
const MIN_MESSAGES_PER_PERSON = 3;
const SAFETY_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Pure fail-closed gate for gift-order creation.
 * Every field must be loaded from trusted server-side records; never pass request-body claims here.
 * This helper does not create an order, authorize payment, or grant address access.
 */
export function evaluateGiftOrderCreation(context, { now = Date.now() } = {}) {
  if (!context || typeof context !== 'object') return deny('missing_context');
  if (!Number.isFinite(now)) return deny('invalid_validation_clock');
  const { sender, recipient, match, product, delivery, activity, safety, idempotency } = context;
  if (!sender || !recipient || !match || !product || !delivery || !activity || !safety || !idempotency) {
    return deny('missing_context');
  }
  if (sender.id == null || recipient.id == null || String(sender.id) === String(recipient.id)) return deny('invalid_participants');
  if (sender.accountStatus !== 'active' || recipient.accountStatus !== 'active') return deny('account_ineligible');
  if (sender.isAdult !== true || recipient.isAdult !== true) return deny('adult_accounts_required');
  if (sender.identityVerified !== true) return deny('sender_identity_not_verified');
  if (sender.safetyRestricted !== false || recipient.safetyRestricted !== false) return deny('safety_state_unavailable_or_restricted');
  if (typeof safety.snapshotAt !== 'string' || safety.snapshotAt.trim().length === 0) return deny('safety_snapshot_stale_or_invalid');
  const safetySnapshotTime = Date.parse(safety.snapshotAt);
  if (!Number.isFinite(safetySnapshotTime) || safetySnapshotTime > now || now - safetySnapshotTime > SAFETY_SNAPSHOT_MAX_AGE_MS) return deny('safety_snapshot_stale_or_invalid');
  if (match.status !== 'active' || match.includesSender !== true || match.includesRecipient !== true) return deny('active_match_required');
  if (!Number.isInteger(match.ageDays) || match.ageDays < MIN_MATCH_AGE_DAYS) return deny('match_too_new');
  if (!Number.isInteger(activity.senderMessages) || !Number.isInteger(activity.recipientMessages) || activity.senderMessages < MIN_MESSAGES_PER_PERSON || activity.recipientMessages < MIN_MESSAGES_PER_PERSON) return deny('insufficient_mutual_conversation');
  if (safety.blocked !== false || safety.openReport !== false) return deny('relationship_safety_state_unavailable_or_restricted');
  if (recipient.giftRequestsEnabled !== true) return deny('recipient_gift_requests_disabled');
  if (activity.pendingRequestsForPair !== 0) return deny('pending_request_exists');
  if (!Number.isInteger(activity.senderRequestsLast30Days) || activity.senderRequestsLast30Days < 0 || activity.senderRequestsLast30Days >= MAX_REQUESTS_PER_30_DAYS) return deny('sender_request_rate_limit');
  if (!Number.isInteger(activity.acceptedGiftsToRecipientLast7Days) || activity.acceptedGiftsToRecipientLast7Days < 0 || activity.acceptedGiftsToRecipientLast7Days >= MAX_ACCEPTED_PER_RECIPIENT_PER_7_DAYS) return deny('recipient_gift_rate_limit');
  if (typeof product.category !== 'string' || !ALLOWED_CATEGORIES.has(product.category)) return deny('gift_category_not_allowed');
  if (product.active !== true || product.approved !== true || product.supplierVerified !== true) return deny('product_or_supplier_not_approved');
  if (!Number.isSafeInteger(product.totalMinorUnits) || product.totalMinorUnits <= 0 || typeof product.currency !== 'string' || !/^[A-Z]{3}$/.test(product.currency)) return deny('invalid_total_price');
  if (delivery.partnerVerified !== true || delivery.coverageActive !== true || delivery.countryCodeMatches !== true || delivery.cityKeyMatches !== true) return deny('delivery_region_unavailable');
  if (idempotency.valid !== true || idempotency.duplicate !== false) return deny('idempotency_check_failed');
  return { eligible: true, reason: 'eligible_pending_recipient_consent', createsOrder: false, paymentAuthorized: false, addressAccessGranted: false };
}

function deny(reason) {
  return { eligible: false, reason, createsOrder: false, paymentAuthorized: false, addressAccessGranted: false };
}
