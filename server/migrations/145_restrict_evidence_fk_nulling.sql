-- Close a mutation loophole in the FK snapshot exceptions introduced by
-- migrations 136 and 137. The live FK may be nulled only by PostgreSQL's
-- nested ON DELETE SET NULL action, never by an ordinary direct UPDATE.
CREATE OR REPLACE FUNCTION prevent_identity_l3_media_access_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $l3_media_access_audit$
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND OLD.submission_id IS NOT NULL
     AND OLD.moderator_user_id IS NOT NULL
     AND (
       (NEW.submission_id IS NULL AND NEW.moderator_user_id IS NOT DISTINCT FROM OLD.moderator_user_id)
       OR
       (NEW.moderator_user_id IS NULL AND NEW.submission_id IS NOT DISTINCT FROM OLD.submission_id)
     )
     AND (to_jsonb(NEW) - 'submission_id' - 'moderator_user_id')
         = (to_jsonb(OLD) - 'submission_id' - 'moderator_user_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'identity L3 media access events are append-only'
    USING ERRCODE = '55000';
END;
$l3_media_access_audit$;

CREATE OR REPLACE FUNCTION prevent_gift_delivery_order_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_event_audit$
BEGIN
  -- Only a nested FK action may clear the live actor pointer. A direct UPDATE
  -- must not be able to erase even the live relationship to retained evidence.
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

COMMENT ON FUNCTION prevent_identity_l3_media_access_event_mutation() IS
  'Blocks direct UPDATE/DELETE; permits only nested FK ON DELETE SET NULL of one live provenance FK while immutable UUID snapshots and all other columns remain unchanged.';
COMMENT ON FUNCTION prevent_gift_delivery_order_event_mutation() IS
  'Blocks direct UPDATE/DELETE; permits only nested FK ON DELETE SET NULL of actor_user_id while immutable actor_ref and all other event fields remain unchanged.';
