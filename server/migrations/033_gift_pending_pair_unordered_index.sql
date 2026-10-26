-- Enforce one pending gift request per match regardless of direction.
-- The earlier index used ordered (sender_id, recipient_id) columns, allowing
-- simultaneous requests in opposite directions for the same pair.
DROP INDEX IF EXISTS gift_orders_one_pending_per_unordered_pair_idx;

CREATE UNIQUE INDEX gift_orders_one_pending_per_unordered_pair_idx
  ON gift_delivery_orders (
    match_id,
    LEAST(sender_id, recipient_id),
    GREATEST(sender_id, recipient_id)
  )
  WHERE status = 'awaiting_recipient_consent';

COMMENT ON INDEX gift_orders_one_pending_per_unordered_pair_idx IS
  'At most one awaiting-consent gift order per match and unordered user pair, independent of request direction.';
