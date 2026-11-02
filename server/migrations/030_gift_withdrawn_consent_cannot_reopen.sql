-- A withdrawn gift request must not be reopened into the recipient-consent queue.
-- Existing contradictory rows require manual reconciliation; never rewrite order or payment state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE consent_withdrawn_at IS NOT NULL
      AND status IN (
        'awaiting_recipient_consent', 'recipient_accepted', 'address_verified',
        'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'
      )
  ) THEN
    RAISE EXCEPTION
      'gift consent withdrawal reconciliation required before migration 030';
  END IF;

  ALTER TABLE gift_delivery_orders
    DROP CONSTRAINT IF EXISTS gift_orders_withdrawn_consent_cannot_progress;

  ALTER TABLE gift_delivery_orders
    ADD CONSTRAINT gift_orders_withdrawn_consent_cannot_progress
    CHECK (
      consent_withdrawn_at IS NULL
      OR status NOT IN (
        'awaiting_recipient_consent', 'recipient_accepted', 'address_verified',
        'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed'
      )
    );
END $$;

COMMENT ON CONSTRAINT gift_orders_withdrawn_consent_cannot_progress
  ON gift_delivery_orders IS
  'A gift order with withdrawn recipient consent cannot be reopened for consent or progress to acceptance, address verification, fulfilment, dispatch, delivery, or delivery failure. Reconcile payments separately; this constraint does not mutate payment state.';
