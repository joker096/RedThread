-- Preserve recipient decline intent when a gift payment may still be active.
-- The task is a durable instruction to reconcile, not evidence of a provider void/refund.
ALTER TABLE gift_payment_reconciliation_tasks
  DROP CONSTRAINT IF EXISTS gift_payment_reconciliation_tasks_reason_check;

ALTER TABLE gift_payment_reconciliation_tasks
  ADD CONSTRAINT gift_payment_reconciliation_tasks_reason_check
  CHECK (reason IN (
    'recipient_opted_out',
    'safety_hold',
    'expired_active_payment',
    'recipient_declined_active_payment'
  ));

COMMENT ON CONSTRAINT gift_payment_reconciliation_tasks_reason_check
  ON gift_payment_reconciliation_tasks IS
  'Durable gift payment reconciliation causes. A recipient decline remains pending until a provider confirms the financial outcome; task creation never claims a void or refund.';
