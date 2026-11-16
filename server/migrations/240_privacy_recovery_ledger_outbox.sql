-- The domain mutation and immutable event intent are committed in one PostgreSQL transaction.
-- A worker delivers the pseudonymized stable-ID payload only after that transaction commits.
CREATE TABLE IF NOT EXISTS privacy_recovery_ledger_outbox (
  event_id UUID PRIMARY KEY,
  event_payload JSONB NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'acknowledged', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  ledger_sequence BIGINT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  acknowledged_at TIMESTAMPTZ,
  CHECK (event_payload->>'event_id' = event_id::text),
  CHECK (
    (status = 'acknowledged' AND ledger_sequence IS NOT NULL AND acknowledged_at IS NOT NULL)
    OR (status <> 'acknowledged' AND ledger_sequence IS NULL AND acknowledged_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS privacy_recovery_ledger_outbox_pending_idx
  ON privacy_recovery_ledger_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS privacy_recovery_ledger_outbox_lease_idx
  ON privacy_recovery_ledger_outbox (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS privacy_recovery_ledger_outbox_dead_idx
  ON privacy_recovery_ledger_outbox (created_at)
  WHERE status = 'dead';

COMMENT ON TABLE privacy_recovery_ledger_outbox IS
  'Transactional delivery queue for pseudonymized privacy recovery events. Event UUID and payload are stable across retries; domain changes and outbox inserts share one PostgreSQL transaction.';
