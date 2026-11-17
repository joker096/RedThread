-- Durable, signature-verified Paddle webhook inbox.
-- The raw provider payload is retained only while work is pending/retryable;
-- the processed financial audit remains in paddle_webhook_events and related ledgers.
CREATE TABLE IF NOT EXISTS paddle_webhook_inbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  processed_at TIMESTAMPTZ,
  last_error_code TEXT,
  CONSTRAINT paddle_webhook_inbox_event_id_check
    CHECK (length(event_id) BETWEEN 1 AND 255),
  CONSTRAINT paddle_webhook_inbox_event_type_check
    CHECK (length(event_type) BETWEEN 1 AND 128),
  CONSTRAINT paddle_webhook_inbox_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'dead_letter')),
  CONSTRAINT paddle_webhook_inbox_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 20),
  CONSTRAINT paddle_webhook_inbox_lease_consistency_check
    CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT paddle_webhook_inbox_completion_check
    CHECK ((status = 'completed') = (processed_at IS NOT NULL)),
  CONSTRAINT paddle_webhook_inbox_payload_check
    CHECK (status IN ('completed', 'dead_letter') OR payload IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS paddle_webhook_inbox_claim_idx
  ON paddle_webhook_inbox (next_attempt_at, received_at, event_id)
  WHERE status IN ('pending', 'retry', 'processing');

CREATE INDEX IF NOT EXISTS paddle_webhook_inbox_processed_retention_idx
  ON paddle_webhook_inbox (processed_at)
  WHERE status = 'completed';

COMMENT ON TABLE paddle_webhook_inbox IS
  'Durable queue for Paddle webhook events after SDK signature verification; processing is fenced and replay-safe.';
