-- Durable saga records for privacy-sensitive mutations that must not commit
-- until the independent privacy ledger has acknowledged the exact event.
CREATE TABLE IF NOT EXISTS privacy_recovery_operations (
  operation_id UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_payload JSONB NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged', 'applied')),
  ledger_sequence BIGINT,
  acknowledged_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (event_id = operation_id),
  CHECK (event_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}
  CHECK (event_payload->>'event_id' = event_id::text),
  CHECK (event_payload->>'schema_version' = '1'),
  CHECK (event_payload->>'event_type' IN (
    'account_erasure_requested', 'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested', 'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn', 'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  )),
  CHECK (
    (status IN ('acknowledged', 'applied') AND ledger_sequence > 0 AND acknowledged_at IS NOT NULL)
    OR (status = 'pending' AND ledger_sequence IS NULL AND acknowledged_at IS NULL)
  ),
  CHECK ((status = 'applied' AND applied_at IS NOT NULL) OR (status <> 'applied' AND applied_at IS NULL))
);

CREATE INDEX IF NOT EXISTS privacy_recovery_operations_pending_idx
  ON privacy_recovery_operations (created_at, operation_id)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_operation_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $privacy_recovery_operations$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_payload IS DISTINCT FROM OLD.event_payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'privacy recovery operation identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'acknowledged') THEN
    RAISE EXCEPTION 'pending privacy recovery operation must be acknowledged before apply'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'acknowledged' AND NEW.status NOT IN ('acknowledged', 'applied') THEN
    RAISE EXCEPTION 'acknowledged privacy recovery operation cannot be downgraded'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'applied' AND NEW.status <> 'applied' THEN
    RAISE EXCEPTION 'applied privacy recovery operation cannot be reopened'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' AND (
    NEW.ledger_sequence IS DISTINCT FROM OLD.ledger_sequence
    OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
  ) THEN
    RAISE EXCEPTION 'privacy recovery ledger acknowledgement is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'acknowledged' AND NEW.applied_at IS NOT NULL
     AND NEW.status <> 'applied' THEN
    RAISE EXCEPTION 'applied timestamp requires applied state'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$privacy_recovery_operations$;

DROP TRIGGER IF EXISTS privacy_recovery_operation_identity_immutable
  ON privacy_recovery_operations;
CREATE TRIGGER privacy_recovery_operation_identity_immutable
  BEFORE UPDATE ON privacy_recovery_operations
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_operation_identity_mutation();

COMMENT ON TABLE privacy_recovery_operations IS
  'Durable ACK-gated saga. A domain mutation may commit only in a transaction that locks an acknowledged operation row.';
),
  CHECK (event_payload->>'event_id' = event_id::text),
  CHECK (event_payload->>'schema_version' = '1'),
  CHECK (event_payload->>'event_type' IN (
    'account_erasure_requested', 'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested', 'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn', 'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  )),
  CHECK (
    (status IN ('acknowledged', 'applied') AND ledger_sequence > 0 AND acknowledged_at IS NOT NULL)
    OR (status = 'pending' AND ledger_sequence IS NULL AND acknowledged_at IS NULL)
  ),
  CHECK ((status = 'applied' AND applied_at IS NOT NULL) OR (status <> 'applied' AND applied_at IS NULL))
);

CREATE INDEX IF NOT EXISTS privacy_recovery_operations_pending_idx
  ON privacy_recovery_operations (created_at, operation_id)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_operation_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $privacy_recovery_operations$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_payload IS DISTINCT FROM OLD.event_payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'privacy recovery operation identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'applied' AND NEW.status <> 'applied' THEN
    RAISE EXCEPTION 'applied privacy recovery operation cannot be reopened'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$privacy_recovery_operations$;

DROP TRIGGER IF EXISTS privacy_recovery_operation_identity_immutable
  ON privacy_recovery_operations;
CREATE TRIGGER privacy_recovery_operation_identity_immutable
  BEFORE UPDATE ON privacy_recovery_operations
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_operation_identity_mutation();

COMMENT ON TABLE privacy_recovery_operations IS
  'Durable ACK-gated saga. A domain mutation may commit only in a transaction that locks an acknowledged operation row.';
