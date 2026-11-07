-- Keep minimal safety-screening evidence when an account is physically purged.
-- The live user FK may be nulled, while user_ref preserves the opaque owner UUID.
ALTER TABLE user_safety_screenings
  ADD COLUMN user_ref UUID;

UPDATE user_safety_screenings
SET user_ref = user_id;

ALTER TABLE user_safety_screenings
  ALTER COLUMN user_ref SET NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL,
  DROP CONSTRAINT user_safety_screenings_user_id_fkey,
  ADD CONSTRAINT user_safety_screenings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX user_safety_screenings_user_ref_idx
  ON user_safety_screenings(user_ref, created_at DESC);

CREATE OR REPLACE FUNCTION snapshot_user_safety_screening_owner()
RETURNS trigger LANGUAGE plpgsql AS $screening_owner_snapshot$
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'new safety screenings require a live account reference'
      USING ERRCODE = '23502';
  END IF;
  IF NEW.user_ref IS NOT NULL
     AND NEW.user_ref IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'safety screening owner snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;
  NEW.user_ref := NEW.user_id;
  RETURN NEW;
END;
$screening_owner_snapshot$;

CREATE TRIGGER user_safety_screenings_snapshot_owner
  BEFORE INSERT ON user_safety_screenings
  FOR EACH ROW
  EXECUTE FUNCTION snapshot_user_safety_screening_owner();

CREATE OR REPLACE FUNCTION prevent_user_safety_screening_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $screening_evidence$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety screening evidence cannot be deleted directly'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_ref IS DISTINCT FROM OLD.user_ref
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.flags IS DISTINCT FROM OLD.flags
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'safety screening classification evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    -- Permit only the nested FK ON DELETE SET NULL action. The opaque user_ref
    -- snapshot and all classification/review fields must remain unchanged.
    IF pg_trigger_depth() > 1
       AND OLD.user_id IS NOT NULL
       AND NEW.user_id IS NULL
       AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'safety screening owner reference is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$screening_evidence$;

CREATE TRIGGER user_safety_screenings_evidence_immutable
  BEFORE UPDATE OR DELETE ON user_safety_screenings
  FOR EACH ROW
  EXECUTE FUNCTION prevent_user_safety_screening_evidence_mutation();

CREATE TRIGGER user_safety_screenings_no_truncate
  BEFORE TRUNCATE ON user_safety_screenings
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

-- Photo bytes and rows may be deleted for account privacy, but the immutable
-- upload identity/metadata must not be rewritten while a review decision exists.
CREATE OR REPLACE FUNCTION prevent_photo_asset_metadata_mutation()
RETURNS trigger LANGUAGE plpgsql AS $photo_asset_metadata$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.width IS DISTINCT FROM OLD.width
     OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'photo upload identity and metadata are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$photo_asset_metadata$;

CREATE TRIGGER photo_assets_metadata_immutable
  BEFORE UPDATE ON photo_assets
  FOR EACH ROW
  EXECUTE FUNCTION prevent_photo_asset_metadata_mutation();

CREATE TRIGGER photo_assets_no_truncate
  BEFORE TRUNCATE ON photo_assets
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

-- AI approval evidence must retain the owner UUID even after account deletion
-- removes the private photo asset and its bytes.
CREATE OR REPLACE FUNCTION require_photo_asset_review_audit()
RETURNS trigger LANGUAGE plpgsql AS $photo_review_audit$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.review_status = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1 FROM moderation_audit_log AS audit
      WHERE audit.action = 'photo_ai_approved'
        AND audit.target_type = 'photo'
        AND audit.target_id = NEW.id::text
        AND audit.details->>'userId' = NEW.user_id::text
    ) THEN
      RAISE EXCEPTION 'automatically approved photo requires matching owner-linked moderation evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    IF NEW.review_status NOT IN ('approved', 'rejected') OR NOT EXISTS (
      SELECT 1
      FROM moderation_audit_log AS audit
      JOIN users AS moderator ON moderator.id = audit.moderator_ref
      WHERE audit.action = 'photo_' || NEW.review_status
        AND audit.target_type = 'photo_asset'
        AND audit.target_id = NEW.id::text
        AND audit.details->>'userId' = NEW.user_id::text
        AND moderator.status = 'active'
        AND moderator.role IN ('admin', 'moderator')
    ) THEN
      RAISE EXCEPTION 'photo review transition requires matching active moderator audit evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$photo_review_audit$;

COMMENT ON FUNCTION prevent_user_safety_screening_evidence_mutation() IS
  'Freezes safety screening identity, scope, flags, severity, engine and creation time; permits only audited review fields and nested owner FK nullification while retaining user_ref.';
COMMENT ON FUNCTION prevent_photo_asset_metadata_mutation() IS
  'Freezes photo upload identity and file metadata while allowing the audited review_status lifecycle and privacy-driven row deletion.';
COMMENT ON COLUMN user_safety_screenings.user_ref IS
  'Immutable opaque UUID snapshot of the screened account; user_id may be nulled by its FK after account deletion.';
