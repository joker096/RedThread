-- Keep scheduled gift-request expiry bounded by an index over only pending-consent rows.
-- The worker filters on expires_at and then groups matching pairs; this avoids
-- repeatedly scanning the full gift-order history as the table grows.
CREATE INDEX IF NOT EXISTS gift_orders_expired_consent_candidates_idx
  ON gift_delivery_orders (expires_at, match_id, sender_id, recipient_id)
  WHERE status = 'awaiting_recipient_consent';

COMMENT ON INDEX gift_orders_expired_consent_candidates_idx IS
  'Supports bounded discovery of expired gift requests awaiting recipient consent; excludes all terminal and post-consent orders.';
