-- New media-access audit rows must be created from a real submission and
-- active moderator relationship. Opaque snapshots preserve provenance only
-- after those live foreign keys are later nulled by account/media erasure;
-- they must never be a caller-supplied substitute for the live references.
CREATE OR REPLACE FUNCTION snapshot_identity_l3_media_access_event_refs()
RETURNS trigger LANGUAGE plpgsql AS $l3_media_access_snapshot$
BEGIN
  IF NEW.submission_id IS NULL OR NEW.moderator_user_id IS NULL THEN
    RAISE EXCEPTION 'new L3 media access events require live submission and moderator references'
      USING ERRCODE = '23502';
  END IF;

  IF NEW.submission_ref IS NOT NULL
     AND NEW.submission_ref IS DISTINCT FROM NEW.submission_id THEN
    RAISE EXCEPTION 'L3 media access submission snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.moderator_ref IS NOT NULL
     AND NEW.moderator_ref IS DISTINCT FROM NEW.moderator_user_id THEN
    RAISE EXCEPTION 'L3 media access moderator snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;

  NEW.submission_ref := NEW.submission_id;
  NEW.moderator_ref := NEW.moderator_user_id;
  RETURN NEW;
END;
$l3_media_access_snapshot$;

COMMENT ON FUNCTION snapshot_identity_l3_media_access_event_refs() IS
  'Requires live submission and moderator foreign keys on insert and snapshots those exact UUIDs. Only later nested FK ON DELETE SET NULL actions may clear the live columns; callers cannot forge detached provenance snapshots.';
