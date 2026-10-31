-- Prevent terminal order labels from hiding unresolved payment/refund states.
-- Fail visibly if existing rows need reconciliation; never rewrite financial state silently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE (status = 'expired' AND payment_status IN ('authorization_pending', 'authorized', 'captured', 'refund_pending'))
       OR (status = 'cancelled' AND payment_status = 'refund_pending')
  ) THEN
    RAISE EXCEPTION
      'gift order payment reconciliation required before migration 025: expired/cancelled orders contain active payment or refund states';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_orders_terminal_payment_reconciliation'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_terminal_payment_reconciliation
      CHECK (
        (status <> 'expired' OR payment_status NOT IN ('authorization_pending', 'authorized', 'captured', 'refund_pending'))
        AND (status <> 'cancelled' OR payment_status <> 'refund_pending')
      );
  END IF;
END $$;
