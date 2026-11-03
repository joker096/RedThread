-- A lifetime entitlement is a mutable projection of immutable purchase evidence.
-- Its transaction/account identity must never be rewritten or erased, and every
-- live row must remain tied to exactly one linked lifetime checkout attempt.
CREATE OR REPLACE FUNCTION prevent_paddle_lifetime_entitlement_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $lifetime_entitlement_identity$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Paddle lifetime entitlement provenance cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Paddle lifetime entitlement transaction and account provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$lifetime_entitlement_identity$;

CREATE TRIGGER paddle_lifetime_entitlements_identity_immutable
  BEFORE UPDATE OR DELETE ON paddle_lifetime_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION prevent_paddle_lifetime_entitlement_identity_mutation();

CREATE TRIGGER paddle_lifetime_entitlements_no_truncate
  BEFORE TRUNCATE ON paddle_lifetime_entitlements
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

CREATE OR REPLACE FUNCTION require_paddle_lifetime_entitlement_owner_evidence()
RETURNS trigger LANGUAGE plpgsql AS $lifetime_entitlement_owner$
DECLARE
  current_user_id UUID;
  linked_owner_count INTEGER;
  matching_linked_owner BOOLEAN;
BEGIN
  -- Read the final row, not the queued trigger tuple: transaction.completed
  -- inserts the entitlement while its checkout attempt is still 'completed',
  -- then atomically finalizes that attempt to 'linked' in the same transaction.
  SELECT user_id
  INTO current_user_id
  FROM paddle_lifetime_entitlements
  WHERE transaction_id = NEW.transaction_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(DISTINCT linked.user_id),
         COALESCE(bool_or(linked.user_id = current_user_id), FALSE)
  INTO linked_owner_count, matching_linked_owner
  FROM (
    SELECT user_id
    FROM paddle_checkout_attempts
    WHERE transaction_id = NEW.transaction_id
      AND plan = 'lifetime'
      AND status = 'linked'
    UNION ALL
    SELECT user_id
    FROM paddle_checkout_attempt_history
    WHERE transaction_id = NEW.transaction_id
      AND plan = 'lifetime'
      AND status = 'linked'
  ) AS linked;

  IF linked_owner_count <> 1 OR NOT matching_linked_owner THEN
    RAISE EXCEPTION 'Paddle lifetime entitlement requires one matching linked lifetime checkout owner'
      USING ERRCODE = '23514';
  END IF;

  -- A retained provider event may be unlinked (NULL owner), but it must not
  -- contradict the lifetime checkout's owner, plan, or completed state.
  IF EXISTS (
    SELECT 1
    FROM paddle_transaction_events AS event
    WHERE event.transaction_id = NEW.transaction_id
      AND (
        event.status <> 'completed'
        OR (event.user_id IS NOT NULL AND event.user_id <> current_user_id)
        OR (event.plan IS NOT NULL AND event.plan <> 'lifetime')
      )
  ) THEN
    RAISE EXCEPTION 'Paddle lifetime entitlement conflicts with retained provider transaction history'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$lifetime_entitlement_owner$;

CREATE CONSTRAINT TRIGGER paddle_lifetime_entitlements_owner_evidence_guard
  AFTER INSERT OR UPDATE ON paddle_lifetime_entitlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_paddle_lifetime_entitlement_owner_evidence();

COMMENT ON FUNCTION prevent_paddle_lifetime_entitlement_identity_mutation() IS
  'Allows the entitlement projection status/reason to change while preventing deletion or rewriting the immutable Paddle transaction and Vow account provenance.';
COMMENT ON FUNCTION require_paddle_lifetime_entitlement_owner_evidence() IS
  'Requires each new or updated lifetime entitlement projection to retain exactly one matching linked lifetime checkout owner and no contradictory completed/canceled provider transaction evidence.';
