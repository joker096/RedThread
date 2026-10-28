-- Safety actions can suspend a gift while a provider-side payment is still active.
-- Queue reconciliation as durable work; never rewrite payment state as if a refund/void happened.
ALTER TABLE gift_payment_reconciliation_tasks
  DROP CONSTRAINT IF EXISTS gift_payment_reconciliation_tasks_reason_check;

ALTER TABLE gift_payment_reconciliation_tasks
  ADD CONSTRAINT gift_payment_reconciliation_tasks_reason_check
  CHECK (reason IN ('recipient_opted_out', 'safety_hold'));

COMMENT ON CONSTRAINT gift_payment_reconciliation_tasks_reason_check
  ON gift_payment_reconciliation_tasks IS
  'Supported causes for provider reconciliation: recipient opt-out or a safety hold after blocking, reporting, account deletion, or moderation.';
