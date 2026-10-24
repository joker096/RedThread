-- Enforce payment/order consistency in PostgreSQL, not only in application helpers.
-- Add constraints separately so existing deployments can apply this migration safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_refunded_payment_consistency'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_refunded_payment_consistency
      CHECK (status <> 'refunded' OR payment_status = 'refunded');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_refund_pending_payment_consistency'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_refund_pending_payment_consistency
      CHECK (status <> 'refund_pending' OR payment_status = 'refund_pending');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_declined_payment_inactive'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_declined_payment_inactive
      CHECK (status <> 'declined' OR payment_status IN ('not_started', 'voided', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_cancelled_payment_inactive'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_cancelled_payment_inactive
      CHECK (status <> 'cancelled' OR payment_status NOT IN ('authorization_pending', 'authorized', 'captured'));
  END IF;
END $$;
