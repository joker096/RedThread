-- Processing completion must mean the parser/scanner pipeline actually finished,
-- not that a worker merely claimed the uploaded row.
CREATE OR REPLACE FUNCTION guard_identity_l3_submission_transition()
RETURNS trigger LANGUAGE plpgsql AS $l3_guard$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'identity L3 submissions must start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity L3 submission identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('upload_authorized', 'withdrawn')
      WHEN 'upload_authorized' THEN NEW.status IN ('uploaded', 'withdrawn')
      WHEN 'uploaded' THEN NEW.status IN ('processing', 'withdrawn', 'failed')
      WHEN 'processing' THEN NEW.status IN ('pending_review', 'withdrawn', 'failed')
      WHEN 'pending_review' THEN NEW.status IN ('approved', 'rejected', 'withdrawn')
      WHEN 'approved' THEN NEW.status IN ('revoked', 'expired')
      ELSE FALSE
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'invalid identity L3 status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('approved', 'rejected')
     AND (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by = NEW.user_id) THEN
    RAISE EXCEPTION 'identity L3 decision requires an independent reviewer' USING ERRCODE = '23514';
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND (
    NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'identity L3 moderator decision is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'identity L3 approval timestamp is required' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'revoked' AND OLD.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved identity L3 submission can be revoked' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('approved', 'rejected', 'revoked')
     AND length(btrim(COALESCE(NEW.decision_reason_code, ''))) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'identity L3 decision requires a bounded reason code' USING ERRCODE = '23514';
  END IF;

  -- Purging is one-way and allowed only after a terminal workflow decision.
  IF NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at AND NOT (
    OLD.media_purged_at IS NULL
    AND NEW.media_purged_at IS NOT NULL
    AND OLD.storage_object_key IS NOT NULL
    AND NEW.storage_object_key IS NULL
    AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired', 'failed')
    AND NEW.status = OLD.status
  ) THEN
    RAISE EXCEPTION 'identity L3 media purge must be a one-way terminal-state operation' USING ERRCODE = '23514';
  END IF;

  -- Media identity is immutable after upload. Processing completion may be
  -- recorded exactly once when processing successfully advances to pending_review.
  IF OLD.status NOT IN ('draft', 'upload_authorized') AND (
    NEW.media_sha256 IS DISTINCT FROM OLD.media_sha256
    OR NEW.media_mime_type IS DISTINCT FROM OLD.media_mime_type
    OR NEW.media_size_bytes IS DISTINCT FROM OLD.media_size_bytes
    OR NEW.media_duration_seconds IS DISTINCT FROM OLD.media_duration_seconds
    OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
    OR (
      NEW.processing_completed_at IS DISTINCT FROM OLD.processing_completed_at
      AND NOT (
        OLD.status = 'processing'
        AND NEW.status = 'pending_review'
        AND OLD.processing_completed_at IS NULL
        AND NEW.processing_completed_at IS NOT NULL
      )
    )
    OR (
      NEW.storage_object_key IS DISTINCT FROM OLD.storage_object_key
      AND NOT (
        OLD.media_purged_at IS NULL
        AND NEW.media_purged_at IS NOT NULL
        AND OLD.storage_object_key IS NOT NULL
        AND NEW.storage_object_key IS NULL
        AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired', 'failed')
        AND NEW.status = OLD.status
      )
    )
  ) THEN
    RAISE EXCEPTION 'identity L3 media metadata is immutable after upload' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$l3_guard$;


CREATE OR REPLACE FUNCTION record_identity_l3_submission_event()
RETURNS trigger LANGUAGE plpgsql AS $l3_event$
DECLARE
  next_event_type TEXT;
  event_actor UUID;
  event_reason TEXT;
BEGIN
  event_actor := NULLIF(current_setting('app.identity_l3_actor_user_id', TRUE), '')::UUID;
  event_reason := NULLIF(current_setting('app.identity_l3_reason_code', TRUE), '');

  IF TG_OP = 'INSERT' THEN
    INSERT INTO identity_l3_decision_events
      (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
    VALUES (NEW.id, NEW.user_id, event_actor, 'created', NULL, NEW.status, event_reason);
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'processing'
       AND NEW.status = 'pending_review'
       AND OLD.processing_completed_at IS NULL
       AND NEW.processing_completed_at IS NOT NULL THEN
      INSERT INTO identity_l3_decision_events
        (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
      VALUES (NEW.id, NEW.user_id, event_actor, 'processing_completed', OLD.status, NEW.status, event_reason);
    END IF;

    next_event_type := CASE NEW.status
      WHEN 'upload_authorized' THEN 'upload_authorized'
      WHEN 'uploaded' THEN 'uploaded'
      WHEN 'processing' THEN 'processing_started'
      WHEN 'failed' THEN 'processing_failed'
      WHEN 'pending_review' THEN 'submitted_for_review'
      WHEN 'approved' THEN 'approved'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'withdrawn' THEN 'withdrawn'
      WHEN 'revoked' THEN 'revoked'
      WHEN 'expired' THEN 'expired'
      ELSE NULL
    END;
    IF next_event_type IS NOT NULL THEN
      INSERT INTO identity_l3_decision_events
        (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
      VALUES (
        NEW.id,
        NEW.user_id,
        CASE WHEN NEW.status IN ('approved', 'rejected') THEN NEW.reviewed_by ELSE event_actor END,
        next_event_type,
        OLD.status,
        NEW.status,
        CASE WHEN NEW.status IN ('approved', 'rejected') THEN NEW.decision_reason_code ELSE event_reason END
      );
    END IF;
  ELSIF NEW.processing_completed_at IS DISTINCT FROM OLD.processing_completed_at
        AND NEW.processing_completed_at IS NOT NULL THEN
    INSERT INTO identity_l3_decision_events
      (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
    VALUES (NEW.id, NEW.user_id, event_actor, 'processing_completed', OLD.status, NEW.status, event_reason);
  ELSIF NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at
        AND NEW.media_purged_at IS NOT NULL THEN
    INSERT INTO identity_l3_decision_events
      (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
    VALUES (NEW.id, NEW.user_id, event_actor, 'media_purged', OLD.status, NEW.status, event_reason);
  END IF;

  RETURN NEW;
END;
$l3_event$;

