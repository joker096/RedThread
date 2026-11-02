-- Audit every successful moderator view of sensitive L3 media without storing
-- addresses, file paths, media contents, or other unnecessary personal data.
CREATE TABLE identity_l3_media_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES identity_l3_submissions(id) ON DELETE CASCADE,
  moderator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  access_type TEXT NOT NULL DEFAULT 'viewed' CHECK (access_type = 'viewed')
);

CREATE INDEX identity_l3_media_access_submission_idx
  ON identity_l3_media_access_events(submission_id, accessed_at DESC, id);
CREATE INDEX identity_l3_media_access_moderator_idx
  ON identity_l3_media_access_events(moderator_user_id, accessed_at DESC, id);

CREATE OR REPLACE FUNCTION prevent_identity_l3_media_access_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $l3_media_access_audit$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity L3 media access events are append-only'
    USING ERRCODE = '55000';
END;
$l3_media_access_audit$;

CREATE TRIGGER identity_l3_media_access_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_media_access_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_media_access_event_mutation();

COMMENT ON TABLE identity_l3_media_access_events IS
  'Append-only audit of authorized moderator views of decrypted L3 video. Contains no media path, IP address, or video content.';
