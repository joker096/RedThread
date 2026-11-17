-- Gift payment reconciliation identity ledger and fenced task leases.
-- This migration adds durable identity/evidence primitives only. No provider
-- adapter is enabled by this migration; execution remains fail-closed until an
-- explicitly injected sandbox adapter is supplied.
ALTER TABLE gift_payment_reconciliation_tasks
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(120),
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

-- Legacy in-flight tasks predate fencing tokens. Requeue them without
-- assuming any provider-side outcome; the next worker must reconcile by identity.
UPDATE gift_payment_reconciliation_tasks
SET status = 'pending',
    next_attempt_at = statement_timestamp(),
    last_error_code = NULL,
    completed_at = NULL
WHERE status = 'in_progress'
  AND lease_token IS NULL
  AND lease_owner IS NULL
  AND claimed_at IS NULL
  AND lease_expires_at IS NULL;

DO $gift_reconciliation_lease_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gift_payment_reconciliation_tasks
    WHERE lease_generation < 0
       OR (status = 'in_progress' AND
           (lease_token IS NULL OR lease_owner IS NULL OR
            claimed_at IS NULL OR lease_expires_at IS NULL))
  ) THEN
    RAISE EXCEPTION 'gift reconciliation task lease state needs manual review before migration 212'
      USING ERRCODE = '23514';
  END IF;
END;
$gift_reconciliation_lease_preflight$;

ALTER TABLE gift_payment_reconciliation_tasks
  ADD CONSTRAINT gift_payment_reconciliation_lease_shape
  CHECK (
    lease_generation >= 0
    AND (
      (status = 'in_progress'
        AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
        AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL
        AND lease_expires_at > claimed_at)
      OR
      (status <> 'in_progress'
        AND lease_token IS NULL AND lease_owner IS NULL
        AND claimed_at IS NULL AND lease_expires_at IS NULL)
    )
  );

CREATE INDEX gift_payment_reconciliation_lease_reclaim_idx
  ON gift_payment_reconciliation_tasks (lease_expires_at, next_attempt_at, id)
  WHERE status = 'in_progress';

CREATE TABLE gift_payment_attempt_identity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES gift_delivery_orders(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL UNIQUE,
  provider_key VARCHAR(80) NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9_]{1,79}$'),
  provider_reference VARCHAR(200)
    CHECK (provider_reference IS NULL OR length(btrim(provider_reference)) > 0),
  idempotency_key VARCHAR(160) NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) > 0),
  amount_minor_units BIGINT NOT NULL CHECK (amount_minor_units > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  provider_reference_recorded_at TIMESTAMPTZ,
  UNIQUE (provider_key, provider_reference),
  CHECK ((provider_reference IS NULL) = (provider_reference_recorded_at IS NULL))
);

CREATE INDEX gift_payment_attempt_identity_order_idx
  ON gift_payment_attempt_identity (order_id, created_at DESC);

CREATE TABLE gift_payment_provider_event_inbox (
  id BIGSERIAL PRIMARY KEY,
  provider_key VARCHAR(80) NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9_]{1,79}$'),
  provider_event_id VARCHAR(200) NOT NULL
    CHECK (length(btrim(provider_event_id)) BETWEEN 1 AND 200),
  event_type VARCHAR(120) NOT NULL
    CHECK (event_type ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  payload_sha256 CHAR(64) NOT NULL
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processed', 'quarantined')),
  processed_at TIMESTAMPTZ,
  quarantine_code VARCHAR(80),
  UNIQUE (provider_key, provider_event_id),
  CHECK ((processing_status = 'processed') = (processed_at IS NOT NULL)),
  CHECK ((processing_status = 'quarantined') = (quarantine_code IS NOT NULL))
);

CREATE INDEX gift_payment_provider_event_pending_idx
  ON gift_payment_provider_event_inbox (received_at, id)
  WHERE processing_status = 'pending';

CREATE OR REPLACE FUNCTION guard_gift_payment_attempt_identity()
RETURNS trigger LANGUAGE plpgsql AS $gift_payment_attempt_identity_guard$
DECLARE
  order_amount BIGINT;
  order_currency CHAR(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT total_minor_units, currency
      INTO order_amount, order_currency
    FROM gift_delivery_orders
    WHERE id = NEW.order_id
    FOR SHARE;
    IF NOT FOUND OR order_amount <> NEW.amount_minor_units
       OR order_currency <> NEW.currency THEN
      RAISE EXCEPTION 'gift payment attempt amount/currency must match the immutable order snapshot'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.provider_reference IS NOT NULL THEN
      NEW.provider_reference_recorded_at := statement_timestamp();
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'gift payment attempt identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.provider_reference IS NULL AND NEW.provider_reference IS NOT NULL THEN
    NEW.provider_reference_recorded_at := statement_timestamp();
  ELSIF NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
     OR NEW.provider_reference_recorded_at IS DISTINCT FROM OLD.provider_reference_recorded_at THEN
    RAISE EXCEPTION 'gift provider reference may be recorded once and cannot be changed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$gift_payment_attempt_identity_guard$;

CREATE TRIGGER gift_payment_attempt_identity_guard
  BEFORE INSERT OR UPDATE ON gift_payment_attempt_identity
  FOR EACH ROW EXECUTE FUNCTION guard_gift_payment_attempt_identity();

CREATE OR REPLACE FUNCTION reject_gift_payment_identity_delete()
RETURNS trigger LANGUAGE plpgsql AS $gift_payment_identity_no_delete$
BEGIN
  RAISE EXCEPTION 'gift payment attempt identity and provider event evidence are append-only'
    USING ERRCODE = '55000';
END;
$gift_payment_identity_no_delete$;

CREATE TRIGGER gift_payment_attempt_identity_no_delete
  BEFORE DELETE ON gift_payment_attempt_identity
  FOR EACH ROW EXECUTE FUNCTION reject_gift_payment_identity_delete();

CREATE TRIGGER gift_payment_provider_event_no_delete
  BEFORE DELETE ON gift_payment_provider_event_inbox
  FOR EACH ROW EXECUTE FUNCTION reject_gift_payment_identity_delete();

CREATE OR REPLACE FUNCTION guard_gift_payment_reconciliation_task_update()
RETURNS trigger LANGUAGE plpgsql AS $gift_payment_task_lease_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.attempt_count <> 0
       OR NEW.completed_at IS NOT NULL OR NEW.last_error_code IS NOT NULL
       OR NEW.lease_generation <> 0 THEN
      RAISE EXCEPTION 'gift payment reconciliation tasks must begin pending and unclaimed'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'gift payment reconciliation task identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed gift payment reconciliation tasks are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('pending', 'failed') AND NEW.status = 'in_progress' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.lease_generation <> OLD.lease_generation + 1
       OR NEW.lease_token IS NULL OR NEW.lease_owner IS NULL
       OR NEW.claimed_at IS NULL OR NEW.lease_expires_at <= NEW.claimed_at THEN
      RAISE EXCEPTION 'gift reconciliation claim must advance generation and establish a complete lease'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'in_progress' AND NEW.status = 'in_progress' THEN
    IF OLD.lease_expires_at <= statement_timestamp()
       AND NEW.attempt_count = OLD.attempt_count + 1
       AND NEW.lease_generation = OLD.lease_generation + 1
       AND NEW.lease_token IS NOT NULL
       AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
       AND NEW.lease_owner IS NOT NULL
       AND NEW.claimed_at IS NOT NULL
       AND NEW.lease_expires_at > NEW.claimed_at THEN
      -- Expired-lease takeover rotates both fencing values.
      NULL;
    ELSIF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
       OR NEW.lease_expires_at < OLD.lease_expires_at THEN
      RAISE EXCEPTION 'gift reconciliation heartbeat must retain its lease fence and cannot shorten expiry'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'in_progress' AND NEW.status IN ('pending', 'failed', 'completed') THEN
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL
       OR NEW.claimed_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'gift reconciliation release must preserve generation and clear the lease'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'failed' AND NEW.status = 'pending' THEN
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation THEN
      RAISE EXCEPTION 'rescheduling failed gift reconciliation must preserve counters'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status = 'failed'
        AND NEW.dead_lettered_at IS NOT NULL THEN
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL
       OR NEW.claimed_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'dead-lettering pending gift reconciliation must preserve counters and clear the lease'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invalid gift payment reconciliation task transition'
      USING ERRCODE = '23514';
  ELSIF NEW.attempt_count <> OLD.attempt_count
     OR NEW.lease_generation <> OLD.lease_generation THEN
    RAISE EXCEPTION 'gift reconciliation counters may change only during claim'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'failed' THEN
    IF NEW.last_error_code IS NULL OR NEW.last_error_code !~ '^[a-z0-9_]{1,80}$' THEN
      RAISE EXCEPTION 'failed gift reconciliation requires a bounded error code'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.last_error_code := NULL;
  END IF;
  IF NEW.status = 'completed' THEN
    NEW.completed_at := statement_timestamp();
  ELSE
    NEW.completed_at := NULL;
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$gift_payment_task_lease_guard$;

DROP TRIGGER IF EXISTS gift_payment_reconciliation_tasks_guard_update
  ON gift_payment_reconciliation_tasks;
CREATE TRIGGER gift_payment_reconciliation_tasks_guard_update
  BEFORE INSERT OR UPDATE ON gift_payment_reconciliation_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_gift_payment_reconciliation_task_update();

COMMENT ON TABLE gift_payment_attempt_identity IS
  'Append-only identity ledger for gift payment attempts. It stores provider IDs and financial snapshots only; never infer provider identity from task text or client input.';
COMMENT ON TABLE gift_payment_provider_event_inbox IS
  'Deduplicated webhook evidence metadata. Raw webhook payloads and recipient personal data are deliberately not stored.';

-- Provider event evidence may be inserted only in pending state and may
-- transition exactly once to processed or quarantined. Payloads are not stored.
CREATE OR REPLACE FUNCTION guard_gift_payment_provider_event_inbox()
RETURNS trigger LANGUAGE plpgsql AS $gift_provider_event_inbox_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.processing_status <> 'pending' OR NEW.processed_at IS NOT NULL
       OR NEW.quarantine_code IS NOT NULL THEN
      RAISE EXCEPTION 'provider webhook evidence must enter the inbox as pending'
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
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'provider webhook event identity and evidence hash are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.processing_status <> 'pending'
     OR NEW.processing_status NOT IN ('processed', 'quarantined') THEN
    RAISE EXCEPTION 'provider webhook event may transition only once from pending'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.processing_status = 'processed' THEN
    NEW.processed_at := statement_timestamp();
    NEW.quarantine_code := NULL;
  ELSE
    IF NEW.quarantine_code IS NULL OR length(NEW.quarantine_code) > 80
       OR NEW.quarantine_code !~ '^[a-z0-9_]+$' THEN
      RAISE EXCEPTION 'quarantined provider webhook event requires a bounded reason code'
        USING ERRCODE = '23514';
    END IF;
    NEW.processed_at := NULL;
  END IF;
  RETURN NEW;
END;
$gift_provider_event_inbox_guard$;

CREATE TRIGGER gift_payment_provider_event_inbox_guard
  BEFORE INSERT OR UPDATE ON gift_payment_provider_event_inbox
  FOR EACH ROW EXECUTE FUNCTION guard_gift_payment_provider_event_inbox();

-- A gift order may have one immutable provider attempt identity. A retry must
-- reuse the same internal attempt/idempotency identity, never invent a new ref.
CREATE UNIQUE INDEX gift_payment_attempt_identity_one_per_order_idx
  ON gift_payment_attempt_identity (order_id);

-- Atomic claim. LIMIT precedes FOR UPDATE per PostgreSQL SELECT grammar.
CREATE OR REPLACE FUNCTION claim_gift_payment_reconciliation_task(
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 90,
  p_max_attempts INTEGER DEFAULT 8
)
RETURNS SETOF gift_payment_reconciliation_tasks
LANGUAGE plpgsql
AS $gift_reconciliation_claim$
DECLARE
  candidate gift_payment_reconciliation_tasks%ROWTYPE;
  claimed gift_payment_reconciliation_tasks%ROWTYPE;
  new_token UUID;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) > 120
     OR p_worker_id !~ '^[A-Za-z0-9._:-]+$'
     OR p_lease_seconds < 15 OR p_lease_seconds > 600
     OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'invalid gift reconciliation worker claim parameters'
      USING ERRCODE = '22023';
  END IF;

  LOOP
    SELECT * INTO candidate
    FROM gift_payment_reconciliation_tasks
    WHERE (
      (status IN ('pending', 'failed') AND dead_lettered_at IS NULL
       AND next_attempt_at <= statement_timestamp())
      OR (status = 'in_progress' AND lease_expires_at <= statement_timestamp())
    )
    ORDER BY next_attempt_at, created_at, id
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    IF candidate.attempt_count >= p_max_attempts THEN
      UPDATE gift_payment_reconciliation_tasks
      SET status = 'failed',
          last_error_code = 'max_attempts_exhausted',
          dead_lettered_at = COALESCE(dead_lettered_at, statement_timestamp()),
          lease_token = NULL, lease_owner = NULL,
          claimed_at = NULL, lease_expires_at = NULL
      WHERE id = candidate.id;
      CONTINUE;
    END IF;

    new_token := gen_random_uuid();
    UPDATE gift_payment_reconciliation_tasks
    SET status = 'in_progress',
        attempt_count = attempt_count + 1,
        lease_generation = lease_generation + 1,
        lease_token = new_token,
        lease_owner = p_worker_id,
        claimed_at = statement_timestamp(),
        lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
        dead_lettered_at = NULL
    WHERE id = candidate.id
    RETURNING * INTO claimed;

    RETURN NEXT claimed;
    RETURN;
  END LOOP;
END;
$gift_reconciliation_claim$;

CREATE OR REPLACE FUNCTION heartbeat_gift_payment_reconciliation_task(
  p_task_id BIGINT,
  p_lease_token UUID,
  p_lease_generation BIGINT,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $gift_reconciliation_heartbeat$
DECLARE
  affected INTEGER;
BEGIN
  IF p_lease_seconds < 15 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid gift reconciliation heartbeat duration'
      USING ERRCODE = '22023';
  END IF;
  UPDATE gift_payment_reconciliation_tasks
  SET lease_expires_at = GREATEST(
    lease_expires_at,
    statement_timestamp() + make_interval(secs => p_lease_seconds)
  )
  WHERE id = p_task_id
    AND status = 'in_progress'
    AND lease_token = p_lease_token
    AND lease_generation = p_lease_generation
    AND lease_expires_at > statement_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$gift_reconciliation_heartbeat$;

CREATE OR REPLACE VIEW gift_payment_reconciliation_health AS
SELECT
  COUNT(*) FILTER (WHERE task.status = 'pending')::BIGINT AS pending_tasks,
  COUNT(*) FILTER (WHERE task.status IN ('pending', 'failed')
    AND task.dead_lettered_at IS NULL
    AND task.next_attempt_at <= statement_timestamp())::BIGINT AS due_tasks,
  COUNT(*) FILTER (WHERE task.status = 'in_progress')::BIGINT AS in_progress_tasks,
  COUNT(*) FILTER (WHERE task.status = 'in_progress'
    AND task.lease_expires_at <= statement_timestamp())::BIGINT AS expired_leases,
  COUNT(*) FILTER (WHERE task.dead_lettered_at IS NOT NULL)::BIGINT AS dead_letter_tasks,
  COUNT(*) FILTER (WHERE task.status = 'failed'
    AND task.dead_lettered_at IS NULL)::BIGINT AS retryable_failures,
  COUNT(*) FILTER (WHERE task.status IN ('pending', 'failed')
    AND task.dead_lettered_at IS NULL AND identity.order_id IS NULL)::BIGINT
      AS tasks_missing_payment_identity,
  (SELECT COUNT(*)::BIGINT FROM gift_payment_provider_event_inbox
    WHERE processing_status = 'quarantined') AS quarantined_provider_events,
  MIN(task.created_at) FILTER (WHERE task.status IN ('pending', 'failed')
    AND task.dead_lettered_at IS NULL) AS oldest_retryable_task_created_at
FROM gift_payment_reconciliation_tasks AS task
LEFT JOIN gift_payment_attempt_identity AS identity
  ON identity.order_id = task.order_id;

COMMENT ON VIEW gift_payment_reconciliation_health IS
  'Aggregate gift-payment reconciliation health counters only; no user, order, provider reference, or recipient personal data.';
COMMENT ON FUNCTION claim_gift_payment_reconciliation_task(TEXT, INTEGER, INTEGER) IS
  'Claims one due gift reconciliation task using SKIP LOCKED; expired leases are reclaimed with a rotated token and incremented fencing generation.';
COMMENT ON FUNCTION heartbeat_gift_payment_reconciliation_task(BIGINT, UUID, BIGINT, INTEGER) IS
  'Extends only a still-live lease matching both token and generation; stale workers cannot heartbeat after takeover.';
