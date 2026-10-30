const PENDING_CONSENT = 'awaiting_recipient_consent';
const SENDER_HIDDEN_TERMINAL_STATES = new Set([
  'declined', 'expired', 'cancelled', 'blocked', 'reported'
]);

/**
 * Projects an order's display status without changing payment or order state.
 * Requests that expired or were invalidated by recipient opt-out are never
 * presented as actionable, even while a payment reconciliation task is pending.
 */
export function projectGiftOrderStatus(order, now = Date.now()) {
  if (!order || typeof order.status !== 'string') return 'not_available';

  const role = order.myRole;
  if (role !== 'sender' && role !== 'recipient') return 'not_available';

  if (role === 'sender' && SENDER_HIDDEN_TERMINAL_STATES.has(order.status)) {
    return 'not_available';
  }

  if (order.status !== PENDING_CONSENT) return order.status;
  if (order.recipientRequestsDisabledAt !== null && order.recipientRequestsDisabledAt !== undefined) {
    return 'not_available';
  }

  const expiresAt = typeof order.expiresAt === 'string' || order.expiresAt instanceof Date
    ? new Date(order.expiresAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return 'not_available';
  if (expiresAt <= now) return role === 'recipient' ? 'expired' : 'not_available';

  return PENDING_CONSENT;
}
