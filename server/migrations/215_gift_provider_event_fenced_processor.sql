-- Durable provider-event processing with exact payment-attempt binding.
-- Raw webhook payloads and signatures are never stored. Live environments are rejected.
ALTER TABLE gift_payment_provider_event_inbox
  ADD COLUMN provider_account_id VARCHAR(200),
  ADD COLUMN environment VARCHAR(20),
  ADD COLUMN provider_reference VARCHAR(200),
  ADD COLUMN amount_minor_units BIGINT,
  ADD COLUMN currency CHAR(3),
  ADD COLUMN matched_attempt_id UUID REFERENCES gift_payment_attempt_identity(attempt_id) ON DELETE RESTRICT,
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_owner VARCHAR(120),
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE gift_payment_provider_event_inbox
  ADD CONSTRAINT gift_provider_event_account_nonblank
    CHECK (provider_account_id IS NULL OR length(btrim(provider_account_id)) BETWEEN 1 AND 200),
  ADD CONSTRAINT gift_provider_event_sandbox_only
    CHECK (environment IS NULL OR environment = 'sandbox'),
  ADD CONSTRAINT gift_provider_event_payment_metadata_shape
    CHECK (
      (provider_reference IS NULL AND amount_minor_units IS NULL AND currency IS NULL)
      OR
      (provider_reference IS NOT NULL AND length(btrim(provider_reference)) BETWEEN 1 AND 200
       AND amount_minor_units > 0 AND currency ~ '^[A-Z]{3}$'
       AND provider_account_id IS NOT NULL AND environment = 'sandbox')
    ),
  ADD CONSTRAINT gift_provider_event_lease_shape
    CHECK (
      lease_generation >= 0 AND attempt_count >= 0
      AND (
        (lease_token IS NULL AND lease_owner IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
        OR
        (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND claimed_at IS NOT NULL
         AND lease_expires_at IS NOT NULL AND lease_expires_at > claimed_at
         AND processing_status = 'pending')
      )
    ),
  ADD CONSTRAINT gift_provider_event_match_shape
    CHECK ((processing_status = 'processed') = (matched_attempt_id IS NOT NULL));

ALTER TABLE gift_payment_provider_event_conflicts
  ADD COLUMN conflicting_provider_account_id VARCHAR(200),
  ADD COLUMN conflicting_environment VARCHAR(20),
  ADD COLUMN conflicting_provider_reference VARCHAR(200),
  ADD COLUMN conflicting_amount_minor_units BIGINT,
  ADD COLUMN conflicting_currency CHAR(3);

CREATE INDEX gift_payment_provider_event_lease_idx
  ON gift_payment_provider_event_inbox (lease_expires_at, received_at, id)
  WHERE processing_status = 'pending';

DROP FUNCTION record_verified_gift_provider_event(VARCHAR, VARCHAR, VARCHAR, CHAR, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION guard_gift_payment_provider_event_inbox()
RETURNS trigger LANGUAGE plpgsql AS $gift_provider_event_inbox_guard_v2$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.processing_status <> 'pending' OR NEW.processed_at IS NOT NULL
       OR NEW.quarantine_code IS NOT NULL OR NEW.matched_attempt_id IS NOT NULL
       OR NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL
       OR NEW.claimed_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
       OR NEW.lease_generation <> 0 OR NEW.attempt_count <> 0 THEN
      RAISE EXCEPTION 'provider webhook evidence must enter the inbox pending and unclaimed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
     OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'provider webhook event identity and verified metadata are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.processing_status <> 'pending' THEN
    RAISE EXCEPTION 'provider webhook event is terminal and immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.processing_status = 'pending' THEN
    IF NEW.matched_attempt_id IS NOT NULL OR NEW.processed_at IS NOT NULL
       OR NEW.quarantine_code IS NOT NULL THEN
      RAISE EXCEPTION 'pending provider event cannot contain terminal evidence'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_token IS NULL OR NEW.lease_owner IS NULL
       OR NEW.claimed_at IS NULL OR NEW.lease_expires_at <= NEW.claimed_at
       OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
       OR NEW.lease_generation <> OLD.lease_generation + 1
       OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'provider event claim must rotate lease token and advance fencing counters'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.processing_status = 'processed' THEN
    IF OLD.lease_token IS NULL OR OLD.lease_expires_at <= statement_timestamp()
       OR NEW.matched_attempt_id IS NULL OR NEW.quarantine_code IS NOT NULL
       OR NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL
       OR NEW.claimed_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'provider event processing requires a live matching lease and exact attempt'
        USING ERRCODE = '23514';
    END IF;
    NEW.processed_at := statement_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.processing_status = 'quarantined' THEN
    IF NEW.quarantine_code IS NULL OR NEW.quarantine_code !~ '^[a-z0-9_]{1,80}$'
       OR NEW.matched_attempt_id IS NOT NULL
       OR NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL
       OR NEW.claimed_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'quarantined provider event requires bounded reason and cleared lease'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.quarantine_code NOT IN ('event_id_payload_conflict', 'max_attempts_exhausted')
       AND (OLD.lease_token IS NULL OR OLD.lease_expires_at <= statement_timestamp()) THEN
      RAISE EXCEPTION 'provider event quarantine requires a live lease'
        USING ERRCODE = '23514';
    END IF;
    NEW.processed_at := NULL;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid provider event processing transition'
    USING ERRCODE = '23514';
END;
$gift_provider_event_inbox_guard_v2$;

CREATE OR REPLACE FUNCTION claim_gift_provider_event_inbox(
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 60,
  p_max_attempts INTEGER DEFAULT 8
)
RETURNS SETOF gift_payment_provider_event_inbox
LANGUAGE plpgsql AS $gift_provider_event_claim$
DECLARE
  candidate gift_payment_provider_event_inbox%ROWTYPE;
  claimed gift_payment_provider_event_inbox%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 120
     OR p_worker_id !~ '^[A-Za-z0-9._:-]+$'
     OR p_lease_seconds < 15 OR p_lease_seconds > 600
     OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid gift provider event claim parameters'
      USING ERRCODE = '22023';
  END IF;

  LOOP
    SELECT * INTO candidate
      FROM gift_payment_provider_event_inbox
     WHERE processing_status = 'pending'
       AND (lease_token IS NULL OR lease_expires_at <= statement_timestamp())
     ORDER BY received_at, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN RETURN; END IF;

    IF candidate.attempt_count >= p_max_attempts THEN
      UPDATE gift_payment_provider_event_inbox
         SET processing_status = 'quarantined',
             quarantine_code = 'max_attempts_exhausted',
             lease_token = NULL, lease_owner = NULL,
             claimed_at = NULL, lease_expires_at = NULL
       WHERE id = candidate.id;
      CONTINUE;
    END IF;

    UPDATE gift_payment_provider_event_inbox
       SET lease_token = gen_random_uuid(),
           lease_owner = p_worker_id,
           claimed_at = statement_timestamp(),
           lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
           lease_generation = lease_generation + 1,
           attempt_count = attempt_count + 1
     WHERE id = candidate.id
     RETURNING * INTO claimed;

    RETURN NEXT claimed;
    RETURN;
  END LOOP;
END;
$gift_provider_event_claim$;

CREATE OR REPLACE FUNCTION record_verified_gift_provider_event(
  p_provider_key VARCHAR(80),
  p_provider_event_id VARCHAR(200),
  p_event_type VARCHAR(120),
  p_payload_sha256 CHAR(64),
  p_occurred_at TIMESTAMPTZ,
  p_provider_account_id VARCHAR(200),
  p_environment VARCHAR(20),
  p_provider_reference VARCHAR(200),
  p_amount_minor_units BIGINT,
  p_currency CHAR(3)
)
RETURNS TEXT LANGUAGE plpgsql AS $record_verified_gift_provider_event_v2$
DECLARE
  inserted_id BIGINT;
  original_event gift_payment_provider_event_inbox%ROWTYPE;
BEGIN
  IF p_provider_key IS NULL OR p_provider_key !~ '^[a-z][a-z0-9_]{1,79}$'
     OR p_provider_event_id IS NULL OR length(btrim(p_provider_event_id)) NOT BETWEEN 1 AND 200
     OR p_event_type IS NULL OR p_event_type !~ '^[a-z][a-z0-9_.-]{0,119}$'
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$'
     OR p_provider_account_id IS NULL OR length(btrim(p_provider_account_id)) NOT BETWEEN 1 AND 200
     OR p_environment IS DISTINCT FROM 'sandbox'
     OR p_provider_reference IS NULL OR length(btrim(p_provider_reference)) NOT BETWEEN 1 AND 200
     OR p_amount_minor_units IS NULL OR p_amount_minor_units <= 0
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invalid verified gift provider event metadata'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO gift_payment_provider_event_inbox
    (provider_key, provider_event_id, event_type, payload_sha256, occurred_at,
     provider_account_id, environment, provider_reference, amount_minor_units, currency)
  VALUES
    (p_provider_key, p_provider_event_id, p_event_type, p_payload_sha256, p_occurred_at,
     p_provider_account_id, p_environment, p_provider_reference, p_amount_minor_units, p_currency)
  ON CONFLICT (provider_key, provider_event_id) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN RETURN 'inserted'; END IF;

  SELECT * INTO original_event
    FROM gift_payment_provider_event_inbox
   WHERE provider_key = p_provider_key AND provider_event_id = p_provider_event_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gift provider event conflict lookup failed'
      USING ERRCODE = '40001';
  END IF;

  IF original_event.payload_sha256 = p_payload_sha256
     AND original_event.event_type = p_event_type
     AND original_event.occurred_at IS NOT DISTINCT FROM p_occurred_at
     AND original_event.provider_account_id = p_provider_account_id
     AND original_event.environment = p_environment
     AND original_event.provider_reference = p_provider_reference
     AND original_event.amount_minor_units = p_amount_minor_units
     AND original_event.currency = p_currency THEN
    RETURN 'duplicate';
  END IF;

  INSERT INTO gift_payment_provider_event_conflicts
    (provider_key, provider_event_id, original_payload_sha256,
     conflicting_payload_sha256, conflicting_event_type, conflicting_occurred_at,
     conflicting_provider_account_id, conflicting_environment, conflicting_provider_reference,
     conflicting_amount_minor_units, conflicting_currency)
  VALUES
    (p_provider_key, p_provider_event_id, original_event.payload_sha256,
     p_payload_sha256, p_event_type, p_occurred_at,
     p_provider_account_id, p_environment, p_provider_reference,
     p_amount_minor_units, p_currency)
  ON CONFLICT (provider_key, provider_event_id, conflicting_payload_sha256) DO NOTHING;

  IF original_event.processing_status = 'pending' THEN
    UPDATE gift_payment_provider_event_inbox
       SET processing_status = 'quarantined',
           quarantine_code = 'event_id_payload_conflict',
           lease_token = NULL, lease_owner = NULL,
           claimed_at = NULL, lease_expires_at = NULL
     WHERE id = original_event.id;
  END IF;
  RETURN 'conflict';
END;
$record_verified_gift_provider_event_v2$;

REVOKE ALL ON FUNCTION claim_gift_provider_event_inbox(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_verified_gift_provider_event(VARCHAR, VARCHAR, VARCHAR, CHAR, TIMESTAMPTZ, VARCHAR, VARCHAR, VARCHAR, BIGINT, CHAR) FROM PUBLIC;

COMMENT ON FUNCTION claim_gift_provider_event_inbox(TEXT, INTEGER, INTEGER) IS
  'Claims one verified gift provider event with SKIP LOCKED and a rotating fencing token; expired leases are safely reclaimed.';
COMMENT ON TABLE gift_payment_provider_event_inbox IS
  'Hash-only verified webhook inbox with bounded routing metadata, exact immutable payment-attempt matching, and fenced processing leases. Raw bodies and signatures are never stored.';
