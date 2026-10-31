-- Permanently invalidate pending gift requests when the recipient opts out.
-- This is separate from per-order consent withdrawal and never changes payment state.
ALTER TABLE gift_delivery_orders
  ADD COLUMN IF NOT EXISTS recipient_requests_disabled_at TIMESTAMPTZ;

COMMENT ON COLUMN gift_delivery_orders.recipient_requests_disabled_at IS
  'Timestamp when the recipient opted out while this request was pending. Once set, the request cannot be accepted or replayed, even if future requests are enabled again.';
