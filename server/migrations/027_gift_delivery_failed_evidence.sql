-- Delivery failure is still a post-authorization outcome: preserve the evidence and
-- active payment state needed for safe reconciliation/refund handling.
-- Fail visibly on legacy rows; never fabricate consent, address, or fulfilment evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE status = 'delivery_failed'
      AND (
        recipient_consent_at IS NULL
        OR address_vault_ref IS NULL
        OR btrim(address_vault_ref) = ''
        OR address_verified_at IS NULL
        OR fulfilment_authorized_at IS NULL
        OR payment_status NOT IN ('authorized', 'captured')
      )
  ) THEN
    RAISE EXCEPTION
      'gift delivery-failed evidence reconciliation required before migration 027';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_orders_delivery_failed_consent_required'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_delivery_failed_consent_required
      CHECK (status <> 'delivery_failed' OR recipient_consent_at IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_orders_delivery_failed_address_required'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_delivery_failed_address_required
      CHECK (
        status <> 'delivery_failed'
        OR (
          address_vault_ref IS NOT NULL
          AND btrim(address_vault_ref) <> ''
          AND address_verified_at IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_orders_delivery_failed_fulfilment_payment_required'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_delivery_failed_fulfilment_payment_required
      CHECK (
        status <> 'delivery_failed'
        OR (
          fulfilment_authorized_at IS NOT NULL
          AND payment_status IN ('authorized', 'captured')
        )
      );
  END IF;
END $$;
