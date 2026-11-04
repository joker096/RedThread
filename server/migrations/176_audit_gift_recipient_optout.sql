ALTER TABLE gift_delivery_order_events
  DROP CONSTRAINT IF EXISTS gift_delivery_order_events_event_type_check;

ALTER TABLE gift_delivery_order_events
  ADD CONSTRAINT gift_delivery_order_events_event_type_check
  CHECK (event_type IN (
    'request_created', 'accepted', 'declined', 'expired', 'address_verified',
    'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed',
    'cancelled', 'consent_withdrawn', 'recipient_opted_out',
    'blocked', 'reported', 'payment_authorized', 'payment_captured',
    'payment_voided', 'refund_requested', 'refunded', 'safety_hold',
    'payment_reconciliation_required'
  ));

COMMENT ON CONSTRAINT gift_delivery_order_events_event_type_check
  ON gift_delivery_order_events IS
  'Permitted append-only gift order audit events, including explicit recipient opt-out, consent withdrawal, and payment reconciliation requirements.';
