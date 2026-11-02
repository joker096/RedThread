-- A recipient's explicit consent withdrawal is terminal for fulfilment progression.
-- Reconcile legacy contradictions manually; never rewrite order or payment state here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE consent_withdrawn_at IS NOT NULL
      AND status IN (
        'recipient_accepted', 'address_verified', 'fulfilment_authorized',
        'dispatched', 'delivered', 'delivery_failed'
      )
  ) THEN
    RAISE EXCEPTION
      'gift consent withdrawal reconciliation required before migration 028';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_orders_withdrawn_consent_cannot_progress'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_withdrawn_consent_cannot_progress
      CHECK (
        consent_withdrawn_at IS NULL
        OR status NOT IN (
          'recipient_accepted', 'address_verified', 'fulfilment_authorized',
          'dispatched', 'delivered', 'delivery_failed'
        )
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT gift_orders_withdrawn_consent_cannot_progress
  ON gift_delivery_orders IS
  'A gift order with withdrawn recipient consent cannot progress to accepted, address-verified, fulfilment-authorized, dispatched, delivered, or delivery-failed states. Reconcile payments separately; this constraint does not mutate payment state.';
