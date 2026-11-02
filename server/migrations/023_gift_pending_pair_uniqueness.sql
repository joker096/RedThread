-- Enforce at most one pending gift request per match regardless of direction.
-- Build the normalized unique index before dropping the older directional index.
-- If legacy rows contain opposite-direction pending requests, this migration fails
-- atomically and leaves the existing protection in place for manual reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS gift_orders_one_pending_per_unordered_pair_idx
  ON gift_delivery_orders (
    match_id,
    LEAST(sender_id, recipient_id),
    GREATEST(sender_id, recipient_id)
  )
  WHERE status = 'awaiting_recipient_consent';

DROP INDEX IF EXISTS gift_orders_one_pending_per_pair_idx;
