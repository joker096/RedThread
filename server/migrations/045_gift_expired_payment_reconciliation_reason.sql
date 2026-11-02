-- Expired consent requests with a potentially active payment need durable provider reconciliation.
ALTER TABLE gift_payment_reconciliation_tasks
  DROP CONSTRAINT IF EXISTS gift_payment_reconciliation_tasks_reason_check;

ALTER TABLE gift_payment_reconciliation_tasks
  ADD CONSTRAINT gift_payment_reconciliation_tasks_reason_check
  CHECK (reason IN ('recipient_opted_out', 'safety_hold', 'expired_active_payment'));

COMMENT ON CONSTRAINT gift_payment_reconciliation_tasks_reason_check
  ON gift_payment_reconciliation_tasks IS
  'Supported causes for provider reconciliation: recipient opt-out, safety hold, or expiry with an active/uncertain payment.';
