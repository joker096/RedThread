-- Scope inbox claims to one explicitly configured provider and reject partial routing metadata.
ALTER TABLE gift_payment_provider_event_inbox
  DROP CONSTRAINT gift_provider_event_payment_metadata_shape,
  ADD CONSTRAINT gift_provider_event_payment_metadata_shape
    CHECK (
      (provider_reference IS NULL AND amount_minor_units IS NULL AND currency IS NULL)
      OR
      (provider_reference IS NOT NULL
       AND length(btrim(provider_reference)) BETWEEN 1 AND 200
       AND amount_minor_units IS NOT NULL AND amount_minor_units > 0
       AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$'
       AND provider_account_id IS NOT NULL AND environment = 'sandbox')
    );

DROP FUNCTION claim_gift_provider_event_inbox(TEXT, INTEGER, INTEGER);

CREATE FUNCTION claim_gift_provider_event_inbox(
  p_worker_id TEXT,
  p_provider_key VARCHAR(80),
  p_lease_seconds INTEGER DEFAULT 60,
  p_max_attempts INTEGER DEFAULT 8
)
RETURNS SETOF gift_payment_provider_event_inbox
LANGUAGE plpgsql AS $gift_provider_event_claim_v2$
DECLARE
  candidate gift_payment_provider_event_inbox%ROWTYPE;
  claimed gift_payment_provider_event_inbox%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 120
     OR p_worker_id !~ '^[A-Za-z0-9._:-]+$'
     OR p_provider_key IS NULL OR p_provider_key !~ '^[a-z][a-z0-9_]{1,79}$'
     OR p_lease_seconds < 15 OR p_lease_seconds > 600
     OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid gift provider event claim parameters'
      USING ERRCODE = '22023';
  END IF;

  LOOP
    SELECT * INTO candidate
      FROM gift_payment_provider_event_inbox
     WHERE provider_key = p_provider_key
       AND processing_status = 'pending'
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
$gift_provider_event_claim_v2$;

REVOKE ALL ON FUNCTION claim_gift_provider_event_inbox(TEXT, VARCHAR, INTEGER, INTEGER) FROM PUBLIC;
COMMENT ON FUNCTION claim_gift_provider_event_inbox(TEXT, VARCHAR, INTEGER, INTEGER) IS
  'Claims one pending verified gift event for one configured provider only, using SKIP LOCKED and a rotating fencing token.';
