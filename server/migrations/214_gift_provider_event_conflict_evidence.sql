-- Preserve conflicting redeliveries without overwriting the first immutable event.
-- The caller MUST invoke this function only after provider signature verification.
CREATE TABLE gift_payment_provider_event_conflicts (
  id BIGSERIAL PRIMARY KEY,
  provider_key VARCHAR(80) NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9_]{1,79}$'),
  provider_event_id VARCHAR(200) NOT NULL
    CHECK (length(btrim(provider_event_id)) BETWEEN 1 AND 200),
  original_payload_sha256 CHAR(64) NOT NULL
    CHECK (original_payload_sha256 ~ '^[a-f0-9]{64}$'),
  conflicting_payload_sha256 CHAR(64) NOT NULL
    CHECK (conflicting_payload_sha256 ~ '^[a-f0-9]{64}$'),
  conflicting_event_type VARCHAR(120) NOT NULL
    CHECK (conflicting_event_type ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  conflicting_occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (provider_key, provider_event_id, conflicting_payload_sha256),
  CHECK (original_payload_sha256 <> conflicting_payload_sha256)
);

CREATE OR REPLACE FUNCTION reject_gift_payment_provider_event_conflict_mutation()
RETURNS trigger LANGUAGE plpgsql AS $gift_event_conflict_immutable$
BEGIN
  RAISE EXCEPTION 'gift provider event conflict evidence is append-only'
    USING ERRCODE = '55000';
END;
$gift_event_conflict_immutable$;

CREATE TRIGGER gift_payment_provider_event_conflicts_no_update
  BEFORE UPDATE OR DELETE ON gift_payment_provider_event_conflicts
  FOR EACH ROW EXECUTE FUNCTION reject_gift_payment_provider_event_conflict_mutation();

CREATE OR REPLACE FUNCTION record_verified_gift_provider_event(
  p_provider_key VARCHAR(80),
  p_provider_event_id VARCHAR(200),
  p_event_type VARCHAR(120),
  p_payload_sha256 CHAR(64),
  p_occurred_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TEXT LANGUAGE plpgsql AS $record_verified_gift_provider_event$
DECLARE
  inserted_id BIGINT;
  original_event gift_payment_provider_event_inbox%ROWTYPE;
BEGIN
  IF p_provider_key IS NULL OR p_provider_key !~ '^[a-z][a-z0-9_]{1,79}$'
     OR p_provider_event_id IS NULL OR length(btrim(p_provider_event_id)) NOT BETWEEN 1 AND 200
     OR p_event_type IS NULL OR p_event_type !~ '^[a-z][a-z0-9_.-]{0,119}$'
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid verified gift provider event identity'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO gift_payment_provider_event_inbox
    (provider_key, provider_event_id, event_type, payload_sha256, occurred_at)
  VALUES
    (p_provider_key, p_provider_event_id, p_event_type, p_payload_sha256, p_occurred_at)
  ON CONFLICT (provider_key, provider_event_id) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN 'inserted';
  END IF;

  SELECT * INTO original_event
  FROM gift_payment_provider_event_inbox
  WHERE provider_key = p_provider_key
    AND provider_event_id = p_provider_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gift provider event conflict lookup failed'
      USING ERRCODE = '40001';
  END IF;

  IF original_event.payload_sha256 = p_payload_sha256
     AND original_event.event_type = p_event_type
     AND original_event.occurred_at IS NOT DISTINCT FROM p_occurred_at THEN
    RETURN 'duplicate';
  END IF;

  INSERT INTO gift_payment_provider_event_conflicts
    (provider_key, provider_event_id, original_payload_sha256,
     conflicting_payload_sha256, conflicting_event_type, conflicting_occurred_at)
  VALUES
    (p_provider_key, p_provider_event_id, original_event.payload_sha256,
     p_payload_sha256, p_event_type, p_occurred_at)
  ON CONFLICT (provider_key, provider_event_id, conflicting_payload_sha256) DO NOTHING;

  IF original_event.processing_status = 'pending' THEN
    UPDATE gift_payment_provider_event_inbox
       SET processing_status = 'quarantined',
           quarantine_code = 'event_id_payload_conflict'
     WHERE id = original_event.id;
  END IF;

  RETURN 'conflict';
END;
$record_verified_gift_provider_event$;

COMMENT ON TABLE gift_payment_provider_event_conflicts IS
  'Append-only hashes and metadata for verified webhook deliveries that reuse an event ID with different content; raw payloads and personal data are never stored.';
COMMENT ON FUNCTION record_verified_gift_provider_event(VARCHAR, VARCHAR, VARCHAR, CHAR, TIMESTAMPTZ) IS
  'Records only an already cryptographically verified provider event. Returns inserted, duplicate, or conflict; conflicting hashes are preserved separately and pending originals are quarantined. Never changes gift order payment state.';
