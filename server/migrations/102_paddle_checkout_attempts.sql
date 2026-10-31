CREATE TABLE IF NOT EXISTS paddle_checkout_attempts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  transaction_id TEXT UNIQUE,
  plan TEXT NOT NULL CHECK (plan IN ('1month', '3months', 'lifetime')),
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'pending', 'completed', 'linked', 'canceled', 'reconciliation_required')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paddle_checkout_attempts_transaction_id_check
    CHECK (transaction_id IS NULL OR transaction_id ~ '^txn_[A-Za-z0-9]+$'),
  CONSTRAINT paddle_checkout_attempts_transaction_required_check
    CHECK (status IN ('creating', 'reconciliation_required') OR transaction_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS paddle_checkout_attempts_status_created_idx
  ON paddle_checkout_attempts (status, created_at);
