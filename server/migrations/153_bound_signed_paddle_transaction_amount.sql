-- Migration 151 enabled signed transaction totals for Paddle credit events.
-- Keep the stored amount within JavaScript's safe-integer range, matching the
-- parser and preventing values that cannot be represented exactly in audits.
ALTER TABLE paddle_transaction_events
  ADD CONSTRAINT paddle_transaction_events_amount_safe_integer
    CHECK (amount_minor_units IS NULL OR
           amount_minor_units BETWEEN -9007199254740991 AND 9007199254740991);
