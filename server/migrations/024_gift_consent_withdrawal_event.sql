-- The consent-withdrawal endpoint records this audit event. Keep the persisted
-- event allowlist aligned with the API so a valid withdrawal cannot fail at INSERT.
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
