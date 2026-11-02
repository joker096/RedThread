-- Enforce one pending gift request per match regardless of direction.
-- The earlier index used ordered (sender_id, recipient_id) columns, allowing
-- simultaneous requests in opposite directions for the same pair.
--
-- Fail with an actionable message before touching the existing index if legacy
-- data already violates the new invariant. Never silently delete or rewrite
-- either request: operators must reconcile those orders explicitly first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE status = 'awaiting_recipient_consent'
    GROUP BY
      match_id,
      LEAST(sender_id, recipient_id),
      GREATEST(sender_id, recipient_id)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'gift pending-pair reconciliation required before migration 033: multiple opposite-direction pending orders exist for a match and user pair';
  END IF;
END
$$;

DROP INDEX IF EXISTS gift_orders_one_pending_per_unordered_pair_idx;

CREATE UNIQUE INDEX gift_orders_one_pending_per_unordered_pair_idx
  ON gift_delivery_orders (
    match_id,
    LEAST(sender_id, recipient_id),
    GREATEST(sender_id, recipient_id)
  )
  WHERE status = 'awaiting_recipient_consent';

COMMENT ON INDEX gift_orders_one_pending_per_unordered_pair_idx IS
  'At most one awaiting-consent gift order per match and unordered user pair, independent of request direction.';
