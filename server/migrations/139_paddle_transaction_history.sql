-- Immutable provider transaction history is separate from the mutable
-- per-user checkout-attempt pointer. This captures every completed/canceled
-- transaction, including recurring renewals that do not create a new checkout.
CREATE TABLE paddle_transaction_events (
  event_id TEXT PRIMARY KEY
    REFERENCES paddle_webhook_events(event_id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL CHECK (transaction_id ~ '^txn_[A-Za-z0-9]+$'),
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  plan TEXT CHECK (plan IS NULL OR plan IN ('1month', '3months', 'lifetime')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'canceled')),
  amount_minor_units BIGINT CHECK (amount_minor_units IS NULL OR amount_minor_units >= 0),
  currency_code CHAR(3) CHECK (
    currency_code IS NULL OR (length(currency_code) = 3 AND currency_code = upper(currency_code)
      AND currency_code ~ '^[A-Z][A-Z][A-Z]')
  ),
  subscription_id TEXT CHECK (subscription_id IS NULL OR subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  customer_id TEXT CHECK (customer_id IS NULL OR customer_id ~ '^ctm_[A-Za-z0-9]+$'),
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX paddle_transaction_events_transaction_time_idx
  ON paddle_transaction_events(transaction_id, occurred_at DESC, received_at DESC);
CREATE INDEX paddle_transaction_events_user_time_idx
  ON paddle_transaction_events(user_id, occurred_at DESC, received_at DESC)
  WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_paddle_transaction_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $paddle_transaction_event$
BEGIN
  RAISE EXCEPTION 'Paddle transaction history is append-only'
    USING ERRCODE = '55000';
END;
$paddle_transaction_event$;

CREATE TRIGGER paddle_transaction_events_append_only
  BEFORE UPDATE OR DELETE ON paddle_transaction_events
  FOR EACH ROW EXECUTE FUNCTION prevent_paddle_transaction_event_mutation();

CREATE TRIGGER paddle_transaction_events_no_truncate
  BEFORE TRUNCATE ON paddle_transaction_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE paddle_transaction_events IS
  'Append-only minimal history of every Vow-relevant Paddle transaction.completed and transaction.canceled webhook, including recurring renewals. Stores provider IDs, plan/status, amount in minor units and currency, never full payloads or payment credentials.';
COMMENT ON COLUMN paddle_transaction_events.user_id IS
  'Nullable verified Vow account owner. NULL means provider identity was not uniquely linked at receipt time and requires reconciliation; a known tombstone remains referenced for financial audit.';
