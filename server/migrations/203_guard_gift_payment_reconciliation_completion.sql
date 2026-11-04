-- A reconciliation task is a durable instruction, not evidence that a provider action occurred.
-- Require a guarded retry lifecycle and same-transaction provider evidence before completion.
ALTER TABLE gift_delivery_order_events
  DROP CONSTRAINT IF EXISTS gift_delivery_order_events_event_type_check;

ALTER TABLE gift_delivery_order_events
  ADD CONSTRAINT gift_delivery_order_events_event_type_check
  CHECK (event_type IN (
    'request_created', 'accepted', 'declined', 'expired', 'address_verified',
    'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed',
    'cancelled', 'consent_withdrawn', 'recipient_opted_out',
    'blocked', 'reported', 'payment_authorized', 'payment_captured',
    'payment_voided', 'payment_failed', 'refund_requested', 'refunded',
    'safety_hold', 'payment_reconciliation_required'
  ));

CREATE OR REPLACE FUNCTION guard_gift_payment_reconciliation_task_update()
RETURNS trigger LANGUAGE plpgsql AS $gift_payment_task_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.attempt_count <> 0
       OR NEW.completed_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'gift payment reconciliation tasks must begin pending with no attempts or completion evidence'
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

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('pending', 'failed') AND NEW.status = 'in_progress' THEN
      IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
        RAISE EXCEPTION 'claiming gift payment reconciliation work must increment the attempt count exactly once'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'failed' AND NEW.status = 'pending' THEN
      IF NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'rescheduling failed gift payment reconciliation must preserve the attempt count'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'in_progress' AND NEW.status IN ('pending', 'failed', 'completed') THEN
      IF NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'finishing a gift payment reconciliation attempt cannot change its attempt count'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid gift payment reconciliation task state transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'gift payment reconciliation attempt count can change only when work is claimed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'failed' THEN
    IF NEW.last_error_code IS NULL OR NEW.last_error_code !~ '^[a-z0-9_]{1,80}$' THEN
      RAISE EXCEPTION 'failed gift payment reconciliation tasks require a bounded error code'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    -- Never retain free-form provider error text in the retry queue.
    NEW.last_error_code := NULL;
  END IF;

  IF NEW.status = 'completed' THEN
    IF OLD.status <> 'in_progress' THEN
      RAISE EXCEPTION 'gift payment reconciliation must be claimed before completion'
        USING ERRCODE = '23514';
    END IF;
    NEW.completed_at := statement_timestamp();
  ELSE
    NEW.completed_at := NULL;
  END IF;

  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$gift_payment_task_guard$;

DROP TRIGGER IF EXISTS gift_payment_reconciliation_tasks_guard_update
  ON gift_payment_reconciliation_tasks;
CREATE TRIGGER gift_payment_reconciliation_tasks_guard_update
  BEFORE INSERT OR UPDATE ON gift_payment_reconciliation_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_gift_payment_reconciliation_task_update();

CREATE OR REPLACE FUNCTION require_gift_payment_reconciliation_completion_evidence()
RETURNS trigger LANGUAGE plpgsql AS $gift_payment_task_completion$
DECLARE
  order_payment_status TEXT;
  order_status TEXT;
  order_updated_at TIMESTAMPTZ;
  required_event_type TEXT;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NULL;
  END IF;

  SELECT payment_status, status, updated_at
    INTO order_payment_status, order_status, order_updated_at
  FROM gift_delivery_orders
  WHERE id = NEW.order_id;

  IF NOT FOUND OR order_updated_at < transaction_timestamp() THEN
    RAISE EXCEPTION 'gift payment reconciliation completion requires an order payment update in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  IF order_payment_status = 'voided' THEN
    required_event_type := 'payment_voided';
  ELSIF order_payment_status = 'failed' THEN
    required_event_type := 'payment_failed';
  ELSIF order_payment_status = 'refunded' AND order_status = 'refunded' THEN
    required_event_type := 'refunded';
  ELSE
    RAISE EXCEPTION 'gift payment reconciliation cannot complete while provider payment remains active or uncertain'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM gift_delivery_order_events AS event
    WHERE event.order_id = NEW.order_id
      AND event.event_type = required_event_type
      AND event.actor_type = 'payment_service'
      AND event.created_at >= transaction_timestamp()
      AND event.metadata->>'reconciliationTaskId' = NEW.id::text
      AND event.metadata->>'toPaymentStatus' = order_payment_status
      AND event.metadata->>'fromPaymentStatus' IN (
        'authorization_pending', 'authorized', 'captured', 'refund_pending'
      )
      AND length(btrim(COALESCE(event.metadata->>'provider', ''))) BETWEEN 1 AND 80
      AND length(btrim(COALESCE(event.metadata->>'providerReference', ''))) BETWEEN 1 AND 200
    ) THEN
    RAISE EXCEPTION 'gift payment reconciliation completion requires same-transaction provider outcome evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$gift_payment_task_completion$;

DROP TRIGGER IF EXISTS gift_payment_reconciliation_tasks_completion_evidence
  ON gift_payment_reconciliation_tasks;
CREATE CONSTRAINT TRIGGER gift_payment_reconciliation_tasks_completion_evidence
  AFTER UPDATE OF status ON gift_payment_reconciliation_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_gift_payment_reconciliation_completion_evidence();

COMMENT ON FUNCTION guard_gift_payment_reconciliation_task_update() IS
  'Requires pending-first task creation, counted claims, bounded error codes, valid retry transitions and immutable completed tasks.';
COMMENT ON FUNCTION require_gift_payment_reconciliation_completion_evidence() IS
  'A gift payment reconciliation task can complete only in the same transaction as an order payment-state update and append-only payment_service event carrying a bounded provider reference and matching task ID.';
COMMENT ON TABLE gift_payment_reconciliation_tasks IS
  'Durable provider-reconciliation outbox. Tasks begin pending and cannot be completed without a same-transaction provider outcome, matching immutable order event, and inactive/refunded order payment state.';
