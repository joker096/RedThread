-- Keep scheduled gift-request expiry candidate filtering focused on pending-consent rows.
-- The worker filters on expires_at; this partial index avoids scanning terminal
-- and post-consent gift history as the table grows. Candidate ordering may still
-- inspect all currently expired pending rows to rotate fairly between retries.
CREATE INDEX IF NOT EXISTS gift_orders_expired_consent_candidates_idx
  ON gift_delivery_orders (expires_at, match_id, sender_id, recipient_id)
  WHERE status = 'awaiting_recipient_consent';

COMMENT ON INDEX gift_orders_expired_consent_candidates_idx IS
  'Supports filtering expired gift requests awaiting recipient consent while excluding terminal and post-consent order history.';
