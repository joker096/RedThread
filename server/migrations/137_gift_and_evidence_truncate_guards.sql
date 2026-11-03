-- Gift order events are financial/safety evidence, not disposable UI history.
-- Preserve actor provenance when the live user row is physically removed.
ALTER TABLE gift_delivery_order_events
  ADD COLUMN actor_ref UUID;

UPDATE gift_delivery_order_events
SET actor_ref = actor_user_id
WHERE actor_user_id IS NOT NULL;

CREATE INDEX gift_delivery_order_events_actor_ref_idx
  ON gift_delivery_order_events(actor_ref, created_at DESC)
  WHERE actor_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_gift_delivery_order_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_event_audit$
BEGIN
  -- PostgreSQL's nested ON DELETE SET NULL action may clear only the live actor FK.
  -- actor_ref is the immutable opaque snapshot of the original actor identity.
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.actor_user_id IS NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'gift delivery order events are append-only'
    USING ERRCODE = '55000';
END;
$gift_order_event_audit$;

CREATE TRIGGER gift_delivery_order_events_append_only
  BEFORE UPDATE OR DELETE ON gift_delivery_order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_gift_delivery_order_event_mutation();

CREATE OR REPLACE FUNCTION guard_gift_delivery_order_immutable_facts()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_facts$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_reference IS DISTINCT FROM OLD.public_reference
     OR NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.product_name_snapshot IS DISTINCT FROM OLD.product_name_snapshot
     OR NEW.product_category IS DISTINCT FROM OLD.product_category
     OR NEW.total_minor_units IS DISTINCT FROM OLD.total_minor_units
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.delivery_partner_ref IS DISTINCT FROM OLD.delivery_partner_ref THEN
    RAISE EXCEPTION 'gift delivery order purchase facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  -- Catalog cleanup may clear the nullable live catalog pointer. The order's
  -- immutable product name/category/price snapshots preserve purchase evidence.
  IF NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
     AND NOT (OLD.catalog_item_id IS NOT NULL AND NEW.catalog_item_id IS NULL) THEN
    RAISE EXCEPTION 'gift delivery order catalog reference is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$gift_order_facts$;

CREATE TRIGGER gift_delivery_orders_immutable_facts
  BEFORE UPDATE ON gift_delivery_orders
  FOR EACH ROW EXECUTE FUNCTION guard_gift_delivery_order_immutable_facts();

CREATE OR REPLACE FUNCTION prevent_gift_delivery_order_delete()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_delete$
BEGIN
  RAISE EXCEPTION 'gift delivery orders are retained as financial and safety evidence'
    USING ERRCODE = '55000';
END;
$gift_order_delete$;

CREATE TRIGGER gift_delivery_orders_no_delete
  BEFORE DELETE ON gift_delivery_orders
  FOR EACH ROW EXECUTE FUNCTION prevent_gift_delivery_order_delete();

CREATE OR REPLACE FUNCTION prevent_gift_payment_reconciliation_task_delete()
RETURNS trigger LANGUAGE plpgsql AS $gift_payment_task_delete$
BEGIN
  RAISE EXCEPTION 'gift payment reconciliation evidence cannot be deleted'
    USING ERRCODE = '55000';
END;
$gift_payment_task_delete$;

CREATE TRIGGER gift_payment_reconciliation_tasks_no_delete
  BEFORE DELETE ON gift_payment_reconciliation_tasks
  FOR EACH ROW EXECUTE FUNCTION prevent_gift_payment_reconciliation_task_delete();

CREATE OR REPLACE FUNCTION guard_paddle_lifetime_entitlement_identity()
RETURNS trigger LANGUAGE plpgsql AS $lifetime_entitlement_identity$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Paddle lifetime entitlement provenance cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Paddle lifetime entitlement transaction ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$lifetime_entitlement_identity$;

CREATE TRIGGER paddle_lifetime_entitlements_identity_immutable
  BEFORE UPDATE OR DELETE ON paddle_lifetime_entitlements
  FOR EACH ROW EXECUTE FUNCTION guard_paddle_lifetime_entitlement_identity();

-- Row-level UPDATE/DELETE triggers do not fire for TRUNCATE. Protect evidence
-- tables from accidental bulk clearing through direct SQL as well.
CREATE OR REPLACE FUNCTION prevent_evidence_truncate()
RETURNS trigger LANGUAGE plpgsql AS $evidence_truncate$
BEGIN
  RAISE EXCEPTION 'evidence tables cannot be truncated'
    USING ERRCODE = '55000';
END;
$evidence_truncate$;

CREATE TRIGGER user_reports_no_truncate
  BEFORE TRUNCATE ON user_reports
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER moderation_audit_log_no_truncate
  BEFORE TRUNCATE ON moderation_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER paddle_webhook_events_no_truncate
  BEFORE TRUNCATE ON paddle_webhook_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER paddle_checkout_attempts_no_truncate
  BEFORE TRUNCATE ON paddle_checkout_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER paddle_checkout_attempt_history_no_truncate
  BEFORE TRUNCATE ON paddle_checkout_attempt_history
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER paddle_lifetime_entitlements_no_truncate
  BEFORE TRUNCATE ON paddle_lifetime_entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER paddle_adjustment_events_no_truncate
  BEFORE TRUNCATE ON paddle_adjustment_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER identity_l3_media_access_events_no_truncate
  BEFORE TRUNCATE ON identity_l3_media_access_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER gift_delivery_orders_no_truncate
  BEFORE TRUNCATE ON gift_delivery_orders
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER gift_delivery_order_events_no_truncate
  BEFORE TRUNCATE ON gift_delivery_order_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
CREATE TRIGGER gift_payment_reconciliation_tasks_no_truncate
  BEFORE TRUNCATE ON gift_payment_reconciliation_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON FUNCTION guard_paddle_lifetime_entitlement_identity() IS
  'Prevents deletion or reassignment of the user/transaction provenance behind a lifetime Premium entitlement while allowing the status projection to change after verified Paddle adjustments.';
COMMENT ON FUNCTION guard_gift_delivery_order_immutable_facts() IS
  'Prevents edits to gift purchase identity, product, price, currency, idempotency and creation facts while leaving explicit order/payment lifecycle fields mutable.';
COMMENT ON TABLE gift_delivery_order_events IS
  'Append-only gift-order financial/safety audit trail. actor_ref preserves opaque actor provenance after account deletion; metadata excludes recipient secrets.';
COMMENT ON COLUMN gift_delivery_order_events.actor_ref IS
  'Immutable opaque UUID snapshot of the original event actor; actor_user_id may be nulled by its FK after account deletion.';
COMMENT ON FUNCTION prevent_evidence_truncate() IS
  'Blocks TRUNCATE on financial, moderation, gift, and identity audit evidence tables because row-level mutation triggers do not cover TRUNCATE.';
