-- Keep gross transaction totals distinct from the amount due after credits
-- and the remaining balance after payments. Paddle defines these as separate
-- values; collapsing them into one amount loses important financial evidence.
ALTER TABLE paddle_transaction_events
  ADD COLUMN grand_total_minor_units BIGINT,
  ADD COLUMN credit_minor_units BIGINT,
  ADD COLUMN balance_minor_units BIGINT;

ALTER TABLE paddle_transaction_events
  ADD CONSTRAINT paddle_transaction_events_grand_total_safe_integer
    CHECK (grand_total_minor_units IS NULL OR
           grand_total_minor_units BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT paddle_transaction_events_credit_safe_integer
    CHECK (credit_minor_units IS NULL OR
           credit_minor_units BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT paddle_transaction_events_balance_safe_integer
    CHECK (balance_minor_units IS NULL OR
           balance_minor_units BETWEEN -9007199254740991 AND 9007199254740991);

COMMENT ON COLUMN paddle_transaction_events.amount_minor_units IS
  'Paddle details.totals.total: total after discount and tax, before credits.';
COMMENT ON COLUMN paddle_transaction_events.grand_total_minor_units IS
  'Paddle details.totals.grand_total: total due after credits but before payments.';
COMMENT ON COLUMN paddle_transaction_events.credit_minor_units IS
  'Paddle details.totals.credit: credit applied to the transaction.';
COMMENT ON COLUMN paddle_transaction_events.balance_minor_units IS
  'Paddle details.totals.balance: amount remaining due after credits and payments; zero for fully settled transactions.';
