-- A payment reversal/reconciliation is an order-level operation, not one operation per trigger.
-- Keep one durable task for the entire order lifecycle; separate causes remain in the
-- immutable gift_delivery_order_events audit log.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT order_id
    FROM gift_payment_reconciliation_tasks
    GROUP BY order_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'gift reconciliation requires manual deduplication before migration 112: multiple tasks exist for one order';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS gift_payment_reconciliation_one_task_per_order_idx
  ON gift_payment_reconciliation_tasks (order_id);

COMMENT ON INDEX gift_payment_reconciliation_one_task_per_order_idx IS
  'One provider reconciliation task per gift order. Trigger causes are preserved independently in the order event audit log.';
