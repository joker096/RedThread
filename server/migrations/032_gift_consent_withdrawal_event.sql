-- Keep the event audit constraint aligned with the consent-withdrawal route.
-- The route records withdrawal as its own event; without this value the
-- transaction rolls back when inserting the audit event.
ALTER TABLE gift_delivery_order_events
  DROP CONSTRAINT IF EXISTS gift_delivery_order_events_event_type_check;

ALTER TABLE gift_delivery_order_events
  ADD CONSTRAINT gift_delivery_order_events_event_type_check
  CHECK (event_type IN (
    'request_created', 'accepted', 'declined', 'expired', 'address_verified',
    'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed',
    'cancelled', 'consent_withdrawn', 'blocked', 'reported',
    'payment_authorized', 'payment_captured', 'payment_voided',
    'refund_requested', 'refunded', 'safety_hold'
  ));

COMMENT ON CONSTRAINT gift_delivery_order_events_event_type_check
  ON gift_delivery_order_events IS
  'Permitted gift-order audit events, including explicit recipient consent withdrawal.';
