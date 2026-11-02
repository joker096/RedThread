-- Explicit per-order consent withdrawal is distinct from opting out of future requests.
-- Orders retain no raw recipient address; clear the opaque vault reference on withdrawal.
ALTER TABLE gift_delivery_orders
  ADD COLUMN IF NOT EXISTS consent_withdrawn_at TIMESTAMPTZ;

ALTER TABLE gift_delivery_order_events
  DROP CONSTRAINT IF EXISTS gift_delivery_order_events_event_type_check;

ALTER TABLE gift_delivery_order_events
  ADD CONSTRAINT gift_delivery_order_events_event_type_check
  CHECK (event_type IN (
    'request_created', 'accepted', 'declined', 'expired', 'address_verified',
    'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed',
    'cancelled', 'blocked', 'reported', 'payment_authorized', 'payment_captured',
    'payment_voided', 'refund_requested', 'refunded', 'safety_hold',
    'consent_withdrawn'
  ));

COMMENT ON COLUMN gift_delivery_orders.consent_withdrawn_at IS
  'Timestamp when the recipient explicitly withdrew consent for this specific order. Never infer this from future-request preferences.';
