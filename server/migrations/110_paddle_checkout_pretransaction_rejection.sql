-- Paddle may reject a transaction-creation request before a transaction ID
-- exists. Such a definitive provider rejection is terminal and must release
-- the durable checkout slot instead of leaving the attempt stuck in creating.
ALTER TABLE paddle_checkout_attempts
  DROP CONSTRAINT IF EXISTS paddle_checkout_attempts_transaction_required_check;

ALTER TABLE paddle_checkout_attempts
  ADD CONSTRAINT paddle_checkout_attempts_transaction_required_check
  CHECK (status IN ('creating', 'reconciliation_required', 'canceled') OR transaction_id IS NOT NULL);

COMMENT ON CONSTRAINT paddle_checkout_attempts_transaction_required_check
  ON paddle_checkout_attempts IS
  'A provider transaction ID is required for pending, completed and linked attempts; creating, reconciliation_required and definitive pre-transaction canceled attempts may have no transaction ID.';
