-- Actor snapshots must be derived from a live actor FK at event creation.
-- A NULL live FK is valid only for system-generated gift events and automated
-- moderation evidence; it must not be paired with a caller-supplied UUID that
-- falsely attributes the event to a deleted or unrelated person.
CREATE OR REPLACE FUNCTION snapshot_gift_delivery_order_event_actor()
RETURNS trigger LANGUAGE plpgsql AS $gift_actor_snapshot$
BEGIN
  IF NEW.actor_user_id IS NULL THEN
    IF NEW.actor_ref IS NOT NULL THEN
      RAISE EXCEPTION 'gift event actor snapshot requires a live actor reference'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.actor_ref IS NOT NULL
     AND NEW.actor_ref IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'gift event actor snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;

  NEW.actor_ref := NEW.actor_user_id;
  RETURN NEW;
END;
$gift_actor_snapshot$;

CREATE OR REPLACE FUNCTION snapshot_moderation_audit_moderator()
RETURNS trigger LANGUAGE plpgsql AS $moderation_actor_snapshot$
BEGIN
  IF NEW.moderator_id IS NULL THEN
    IF NEW.moderator_ref IS NOT NULL THEN
      RAISE EXCEPTION 'moderation audit actor snapshot requires a live moderator reference'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.moderator_ref IS NOT NULL
     AND NEW.moderator_ref IS DISTINCT FROM NEW.moderator_id THEN
    RAISE EXCEPTION 'moderation audit moderator snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;

  NEW.moderator_ref := NEW.moderator_id;
  RETURN NEW;
END;
$moderation_actor_snapshot$;

COMMENT ON FUNCTION snapshot_gift_delivery_order_event_actor() IS
  'Snapshots only a live actor_user_id. System events may have both actor_user_id and actor_ref NULL; callers cannot forge an opaque actor_ref without a live actor FK.';
COMMENT ON FUNCTION snapshot_moderation_audit_moderator() IS
  'Snapshots only a live moderator_id. Automated audit entries may have both moderator_id and moderator_ref NULL; callers cannot forge a moderator_ref without a live moderator FK.';
