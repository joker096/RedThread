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
  lease_token UUID,
  ledger_sequence BIGINT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  acknowledged_at TIMESTAMPTZ,
  CHECK (COALESCE(event_payload->>'event_id', '') = event_id::text),
  CHECK (event_payload->>'schema_version' = '1'),
  CHECK (event_payload->>'event_type' IN (
    'account_erasure_requested', 'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested', 'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn', 'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  )),
  CHECK (event_payload->>'subject_ref' ~ '^[a-f0-9]{64}
  CHECK ((status = 'processing' AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL)
      OR (status <> 'processing' AND lease_expires_at IS NULL AND lease_token IS NULL)),
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
),
  CHECK (event_payload->>'resource_ref' IS NULL OR event_payload->>'resource_ref' ~ '^[a-f0-9]{64}
  CHECK ((status = 'processing' AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL)
      OR (status <> 'processing' AND lease_expires_at IS NULL AND lease_token IS NULL)),
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
),
  CHECK (event_payload->>'occurred_at' IS NOT NULL),
  CHECK ((status = 'processing' AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL)
      OR (status <> 'processing' AND lease_expires_at IS NULL AND lease_token IS NULL)),
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
