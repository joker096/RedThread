-- Idempotency keys are part of the database uniqueness boundary, not merely request validation.
-- Fail visibly on legacy malformed keys; do not silently normalize or rewrite identifiers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE idempotency_key IS NULL
       OR btrim(idempotency_key) = ''
       OR idempotency_key <> btrim(idempotency_key)
  ) THEN
    RAISE EXCEPTION
      'gift idempotency-key reconciliation required before migration 031';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_orders_idempotency_key_normalized'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_idempotency_key_normalized
      CHECK (
        btrim(idempotency_key) <> ''
        AND idempotency_key = btrim(idempotency_key)
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT gift_orders_idempotency_key_normalized
  ON gift_delivery_orders IS
  'Idempotency keys must be non-empty and have no leading/trailing whitespace. The sender+key unique constraint prevents duplicate requests; this check rejects malformed keys at the database boundary.';
