-- Preserve immutable actor provenance while allowing only PostgreSQL's own
-- FK referential actions to clear nullable live actor references.
ALTER TABLE gift_address_draft_consent_events
  ADD COLUMN IF NOT EXISTS actor_ref UUID;

UPDATE gift_address_draft_consent_events
   SET actor_ref = actor_user_id
 WHERE actor_ref IS NULL
   AND actor_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION snapshot_gift_address_draft_consent_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $gift_draft_actor_snapshot$
BEGIN
  IF NEW.actor_user_id IS NOT NULL
     AND NEW.actor_ref IS NOT NULL
     AND NEW.actor_ref IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'gift address draft consent actor snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;
  NEW.actor_ref := COALESCE(NEW.actor_ref, NEW.actor_user_id);
  RETURN NEW;
END;
$gift_draft_actor_snapshot$;

DROP TRIGGER IF EXISTS gift_address_draft_consent_events_snapshot_actor
  ON gift_address_draft_consent_events;
CREATE TRIGGER gift_address_draft_consent_events_snapshot_actor
  BEFORE INSERT ON gift_address_draft_consent_events
  FOR EACH ROW EXECUTE FUNCTION snapshot_gift_address_draft_consent_actor();

CREATE OR REPLACE FUNCTION reject_gift_address_draft_consent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $draft_consent_immutable$
BEGIN
  -- Only the nested FK ON DELETE SET NULL action may clear the live actor FK.
  -- actor_ref and every other event field remain immutable.
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.actor_user_id IS NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'gift address draft consent history is append-only'
    USING ERRCODE = '23514';
END;
$draft_consent_immutable$;

CREATE OR REPLACE FUNCTION prevent_gift_delivery_order_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $gift_order_event_audit$
BEGIN
  -- A direct UPDATE must never imitate the FK action. The opaque actor_ref
  -- snapshot is retained when PostgreSQL clears only the live actor FK.
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

CREATE OR REPLACE FUNCTION protect_profile_voice_intro_consent_events()
RETURNS trigger
LANGUAGE plpgsql
AS $voice_consent_events_immutable$
BEGIN
  -- Explicit post-tombstone purge remains supported. A physical users DELETE
  -- also removes these rows through nested FK cascades; permit only that
  -- referential action, never a direct DELETE while the account is active.
  IF TG_OP = 'DELETE'
     AND (
       pg_trigger_depth() > 1
       OR EXISTS (
         SELECT 1 FROM users WHERE id = OLD.user_id AND status = 'deleted'
       )
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'profile voice intro consent events are immutable'
    USING ERRCODE = '55000';
END;
$voice_consent_events_immutable$;

COMMENT ON COLUMN gift_address_draft_consent_events.actor_ref IS
  'Immutable opaque snapshot of the original actor UUID; retained when the live actor FK is nulled during account erasure.';
