-- L3 video submissions store metadata and opaque object keys only.
-- Video bytes must live in a separately configured private encrypted object store.
CREATE TABLE identity_l3_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'upload_authorized', 'uploaded', 'processing', 'failed',
      'pending_review', 'approved', 'rejected', 'withdrawn',
      'revoked', 'expired'
    )),
  storage_object_key TEXT,
  media_sha256 CHAR(64),
  media_mime_type TEXT,
  media_size_bytes BIGINT,
  media_duration_seconds SMALLINT,
  uploaded_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  reviewed_by UUID, -- immutable audit identifier; intentionally survives reviewer account deletion
  reviewed_at TIMESTAMPTZ,
  decision_reason_code TEXT,
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  media_purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (media_sha256 IS NULL OR media_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (media_mime_type IS NULL OR media_mime_type IN ('video/mp4', 'video/webm')),
  CHECK (media_size_bytes IS NULL OR media_size_bytes BETWEEN 1 AND 104857600),
  CHECK (media_duration_seconds IS NULL OR media_duration_seconds BETWEEN 30 AND 60),
  CHECK (
    status NOT IN ('uploaded', 'processing', 'failed', 'pending_review', 'approved', 'rejected')
    OR (
      media_sha256 IS NOT NULL AND media_mime_type IS NOT NULL
      AND media_size_bytes IS NOT NULL AND media_duration_seconds IS NOT NULL
      AND uploaded_at IS NOT NULL
      AND (
        (storage_object_key IS NOT NULL AND length(storage_object_key) BETWEEN 1 AND 512)
        OR (media_purged_at IS NOT NULL AND storage_object_key IS NULL)
      )
    )
  ),
  CHECK (
    status <> 'approved'
    OR (
      reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND approved_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at = approved_at + INTERVAL '6 months'
      AND reviewed_by <> user_id
    )
  ),
  CHECK (status NOT IN ('pending_review', 'approved', 'rejected') OR processing_completed_at IS NOT NULL),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (
    status NOT IN ('approved', 'rejected', 'revoked')
    OR (
      length(btrim(COALESCE(decision_reason_code, ''))) BETWEEN 1 AND 64
      AND decision_reason_code !~ '[^a-z0-9_]'
    )
  ),
  CHECK (media_purged_at IS NULL OR storage_object_key IS NULL)
);

-- One live workflow per account; old decisions remain available for audit.
CREATE UNIQUE INDEX identity_l3_one_open_submission_per_user_uidx
  ON identity_l3_submissions(user_id)
  WHERE status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review');

CREATE INDEX identity_l3_moderation_queue_idx
  ON identity_l3_submissions(created_at, id)
  WHERE status = 'pending_review';
CREATE INDEX identity_l3_active_approval_idx
  ON identity_l3_submissions(user_id, expires_at DESC)
  WHERE status = 'approved';
CREATE INDEX identity_l3_expiry_idx
  ON identity_l3_submissions(expires_at, id)
  WHERE status = 'approved';
CREATE INDEX identity_l3_current_decision_idx
  ON identity_l3_submissions(
    user_id, (COALESCE(approved_at, reviewed_at)) DESC,
    (COALESCE(revoked_at, approved_at, reviewed_at)) DESC, created_at DESC, id DESC
  )
  WHERE status IN ('approved', 'rejected', 'revoked', 'expired');

CREATE TABLE identity_l3_decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES identity_l3_submissions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID, -- immutable audit identifier; intentionally survives actor account deletion
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'upload_authorized', 'uploaded', 'processing_started',
    'processing_completed', 'processing_failed', 'submitted_for_review', 'approved',
    'rejected', 'withdrawn', 'revoked', 'expired', 'media_purged'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN (
    'draft', 'upload_authorized', 'uploaded', 'processing', 'failed',
    'pending_review', 'approved', 'rejected', 'withdrawn',
    'revoked', 'expired'
  )),
  reason_code TEXT CHECK (reason_code IS NULL OR (length(reason_code) BETWEEN 1 AND 64 AND reason_code !~ '[^a-z0-9_]')),
  CHECK (event_type NOT IN ('approved', 'rejected') OR (actor_user_id IS NOT NULL AND actor_user_id <> user_id)),
  CHECK (event_type <> 'revoked' OR actor_user_id IS NULL OR actor_user_id <> user_id)
);
CREATE INDEX identity_l3_decision_events_submission_idx
  ON identity_l3_decision_events(submission_id, occurred_at, id);
CREATE INDEX identity_l3_decision_events_user_idx
  ON identity_l3_decision_events(user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_identity_l3_decision_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Permit only referential cleanup initiated by a parent-row cascade (for
  -- example, account deletion). Direct UPDATE/DELETE remains prohibited.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity L3 decision events are append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER identity_l3_decision_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_decision_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_decision_event_mutation();

CREATE OR REPLACE FUNCTION guard_identity_l3_submission_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'identity L3 submissions must start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
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

  IF NEW.status IN ('approved', 'rejected') AND
     (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by = NEW.user_id) THEN
    RAISE EXCEPTION 'identity L3 decision requires an independent reviewer' USING ERRCODE = '23514';
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND (
     NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR
     NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
     NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code OR
     NEW.approved_at IS DISTINCT FROM OLD.approved_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at
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

  -- Once bytes have been accepted, their identity and validation metadata cannot
  -- be swapped underneath a moderation decision. The sole permitted mutation is
  -- clearing the object key while atomically marking the media as purged.
  IF NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at AND NOT (
    OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
    AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
    AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired', 'failed')
    AND NEW.status = OLD.status
  ) THEN
    RAISE EXCEPTION 'identity L3 media purge must be a one-way terminal-state operation' USING ERRCODE = '23514';
  END IF;

  IF OLD.status NOT IN ('draft', 'upload_authorized') AND (
    NEW.media_sha256 IS DISTINCT FROM OLD.media_sha256 OR
    NEW.media_mime_type IS DISTINCT FROM OLD.media_mime_type OR
    NEW.media_size_bytes IS DISTINCT FROM OLD.media_size_bytes OR
    NEW.media_duration_seconds IS DISTINCT FROM OLD.media_duration_seconds OR
    NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at OR
    (NEW.processing_completed_at IS DISTINCT FROM OLD.processing_completed_at AND NOT (
      OLD.status = 'uploaded' AND NEW.status = 'processing'
      AND OLD.processing_completed_at IS NULL AND NEW.processing_completed_at IS NOT NULL
    )) OR
    (NEW.storage_object_key IS DISTINCT FROM OLD.storage_object_key AND NOT (
      OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
      AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
      AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired', 'failed')
      AND NEW.status = OLD.status
    ))
  ) THEN
    RAISE EXCEPTION 'identity L3 media metadata is immutable after upload' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_l3_submission_transition_guard
  BEFORE INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_submission_transition();

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
    IF NEW.status = 'processing' AND NEW.processing_completed_at IS NOT NULL
       AND OLD.processing_completed_at IS NULL THEN
      INSERT INTO identity_l3_decision_events
        (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
      VALUES
        (NEW.id, NEW.user_id, event_actor, 'processing_started', OLD.status, NEW.status, event_reason),
        (NEW.id, NEW.user_id, event_actor, 'processing_completed', NEW.status, NEW.status, event_reason);
      RETURN NEW;
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
        NEW.id, NEW.user_id,
        CASE WHEN NEW.status IN ('approved', 'rejected') THEN NEW.reviewed_by ELSE event_actor END,
        next_event_type, OLD.status, NEW.status,
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

CREATE TRIGGER identity_l3_submission_event_recorder
  AFTER INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION record_identity_l3_submission_event();

CREATE OR REPLACE FUNCTION identity_l3_current_decision(p_user_id UUID)
RETURNS TABLE(status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE AS $l3_decision$
BEGIN
  RETURN QUERY
  SELECT s.status, s.expires_at
  FROM identity_l3_submissions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('approved', 'rejected', 'revoked', 'expired')
  ORDER BY COALESCE(s.approved_at, s.reviewed_at) DESC,
           COALESCE(s.revoked_at, s.approved_at, s.reviewed_at) DESC,
           s.created_at DESC, s.id DESC
  LIMIT 1
  FOR SHARE;
END;
$l3_decision$;

CREATE OR REPLACE FUNCTION identity_l3_has_active_approval(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $l3_active$
DECLARE
  current_status TEXT;
  current_expiry TIMESTAMPTZ;
BEGIN
  SELECT decision.status, decision.expires_at
    INTO current_status, current_expiry
  FROM identity_l3_current_decision(p_user_id) AS decision;

  RETURN COALESCE(current_status = 'approved' AND current_expiry > NOW(), FALSE);
END;
$l3_active$;

COMMENT ON TABLE identity_l3_submissions IS
  'L3 video workflow metadata only. Never store video bytes here; storage_object_key must reference private encrypted object storage.';
COMMENT ON TABLE identity_l3_decision_events IS
  'Append-only L3 workflow and moderation audit events. Avoid raw video, biometric data, document data and free-form personal information.';
COMMENT ON COLUMN identity_l3_submissions.expires_at IS
  'Approval expiry must be exactly six calendar months after approved_at; authorization must check this timestamp against database NOW().';
)
  ),
  CHECK (media_purged_at IS NULL OR storage_object_key IS NULL)
);

-- One live workflow per account; old decisions remain available for audit.
CREATE UNIQUE INDEX identity_l3_one_open_submission_per_user_uidx
  ON identity_l3_submissions(user_id)
  WHERE status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review');

CREATE INDEX identity_l3_moderation_queue_idx
  ON identity_l3_submissions(created_at, id)
  WHERE status = 'pending_review';
CREATE INDEX identity_l3_active_approval_idx
  ON identity_l3_submissions(user_id, expires_at DESC)
  WHERE status = 'approved';
CREATE INDEX identity_l3_expiry_idx
  ON identity_l3_submissions(expires_at, id)
  WHERE status = 'approved';
CREATE INDEX identity_l3_current_decision_idx
  ON identity_l3_submissions(
    user_id, (COALESCE(approved_at, reviewed_at)) DESC,
    (COALESCE(revoked_at, approved_at, reviewed_at)) DESC, created_at DESC, id DESC
  )
  WHERE status IN ('approved', 'rejected', 'revoked', 'expired');

CREATE TABLE identity_l3_decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES identity_l3_submissions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID, -- immutable audit identifier; intentionally survives actor account deletion
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'upload_authorized', 'uploaded', 'processing_started',
    'processing_completed', 'submitted_for_review', 'approved',
    'rejected', 'withdrawn', 'revoked', 'expired', 'media_purged'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN (
    'draft', 'upload_authorized', 'uploaded', 'processing',
    'pending_review', 'approved', 'rejected', 'withdrawn',
    'revoked', 'expired'
  )),
  reason_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (actor_user_id IS NULL OR actor_user_id <> user_id)
);
CREATE INDEX identity_l3_decision_events_submission_idx
  ON identity_l3_decision_events(submission_id, occurred_at, id);
CREATE INDEX identity_l3_decision_events_user_idx
  ON identity_l3_decision_events(user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_identity_l3_decision_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Permit only referential cleanup initiated by a parent-row cascade (for
  -- example, account deletion). Direct UPDATE/DELETE remains prohibited.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity L3 decision events are append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER identity_l3_decision_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_decision_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_decision_event_mutation();

CREATE OR REPLACE FUNCTION guard_identity_l3_submission_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'identity L3 submissions must start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity L3 submission identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('upload_authorized', 'withdrawn')
      WHEN 'upload_authorized' THEN NEW.status IN ('uploaded', 'withdrawn')
      WHEN 'uploaded' THEN NEW.status IN ('processing', 'withdrawn')
      WHEN 'processing' THEN NEW.status IN ('pending_review', 'withdrawn')
      WHEN 'pending_review' THEN NEW.status IN ('approved', 'rejected', 'withdrawn')
      WHEN 'approved' THEN NEW.status IN ('revoked', 'expired')
      ELSE FALSE
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'invalid identity L3 status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('approved', 'rejected') AND
     (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by = NEW.user_id) THEN
    RAISE EXCEPTION 'identity L3 decision requires an independent reviewer' USING ERRCODE = '23514';
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND (
     NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR
     NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
     NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code OR
     NEW.approved_at IS DISTINCT FROM OLD.approved_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at
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

  -- Once bytes have been accepted, their identity and validation metadata cannot
  -- be swapped underneath a moderation decision. The sole permitted mutation is
  -- clearing the object key while atomically marking the media as purged.
  IF NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at AND NOT (
    OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
    AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
    AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired')
    AND NEW.status = OLD.status
  ) THEN
    RAISE EXCEPTION 'identity L3 media purge must be a one-way terminal-state operation' USING ERRCODE = '23514';
  END IF;

  IF OLD.status NOT IN ('draft', 'upload_authorized') AND (
    NEW.media_sha256 IS DISTINCT FROM OLD.media_sha256 OR
    NEW.media_mime_type IS DISTINCT FROM OLD.media_mime_type OR
    NEW.media_size_bytes IS DISTINCT FROM OLD.media_size_bytes OR
    NEW.media_duration_seconds IS DISTINCT FROM OLD.media_duration_seconds OR
    NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at OR
    (NEW.processing_completed_at IS DISTINCT FROM OLD.processing_completed_at AND NOT (
      OLD.status = 'uploaded' AND NEW.status = 'processing'
      AND OLD.processing_completed_at IS NULL AND NEW.processing_completed_at IS NOT NULL
    )) OR
    (NEW.storage_object_key IS DISTINCT FROM OLD.storage_object_key AND NOT (
      OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
      AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
      AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired')
      AND NEW.status = OLD.status
    ))
  ) THEN
    RAISE EXCEPTION 'identity L3 media metadata is immutable after upload' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_l3_submission_transition_guard
  BEFORE INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_submission_transition();

CREATE OR REPLACE FUNCTION record_identity_l3_submission_event()
RETURNS trigger LANGUAGE plpgsql AS $
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
    IF NEW.status = 'processing' AND NEW.processing_completed_at IS NOT NULL
       AND OLD.processing_completed_at IS NULL THEN
      INSERT INTO identity_l3_decision_events
        (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
      VALUES
        (NEW.id, NEW.user_id, event_actor, 'processing_started', OLD.status, NEW.status, event_reason),
        (NEW.id, NEW.user_id, event_actor, 'processing_completed', NEW.status, NEW.status, event_reason);
      RETURN NEW;
    END IF;

    next_event_type := CASE NEW.status
      WHEN 'upload_authorized' THEN 'upload_authorized'
      WHEN 'uploaded' THEN 'uploaded'
      WHEN 'processing' THEN 'processing_started'
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
        NEW.id, NEW.user_id,
        CASE WHEN NEW.status IN ('approved', 'rejected') THEN NEW.reviewed_by ELSE event_actor END,
        next_event_type, OLD.status, NEW.status,
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
$;

CREATE TRIGGER identity_l3_submission_event_recorder
  AFTER INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION record_identity_l3_submission_event();

CREATE OR REPLACE FUNCTION identity_l3_current_decision(p_user_id UUID)
RETURNS TABLE(status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE AS $
BEGIN
  RETURN QUERY
  SELECT s.status, s.expires_at
  FROM identity_l3_submissions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('approved', 'rejected', 'revoked', 'expired')
  ORDER BY COALESCE(s.approved_at, s.reviewed_at) DESC,
           COALESCE(s.revoked_at, s.approved_at, s.reviewed_at) DESC,
           s.created_at DESC, s.id DESC
  LIMIT 1
  FOR SHARE;
END;
$;

CREATE OR REPLACE FUNCTION identity_l3_has_active_approval(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $
DECLARE
  current_status TEXT;
  current_expiry TIMESTAMPTZ;
BEGIN
  SELECT decision.status, decision.expires_at
    INTO current_status, current_expiry
  FROM identity_l3_current_decision(p_user_id) AS decision;

  RETURN COALESCE(current_status = 'approved' AND current_expiry > NOW(), FALSE);
END;
$;

COMMENT ON TABLE identity_l3_submissions IS
  'L3 video workflow metadata only. Never store video bytes here; storage_object_key must reference private encrypted object storage.';
COMMENT ON TABLE identity_l3_decision_events IS
  'Append-only L3 workflow and moderation audit events. Avoid raw video, biometric data, document data and free-form personal information.';
COMMENT ON COLUMN identity_l3_submissions.expires_at IS
  'Approval expiry must be exactly six calendar months after approved_at; authorization must check this timestamp against database NOW().';
),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (actor_user_id IS NULL OR actor_user_id <> user_id)
);
CREATE INDEX identity_l3_decision_events_submission_idx
  ON identity_l3_decision_events(submission_id, occurred_at, id);
CREATE INDEX identity_l3_decision_events_user_idx
  ON identity_l3_decision_events(user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_identity_l3_decision_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Permit only referential cleanup initiated by a parent-row cascade (for
  -- example, account deletion). Direct UPDATE/DELETE remains prohibited.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity L3 decision events are append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER identity_l3_decision_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_decision_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_decision_event_mutation();

CREATE OR REPLACE FUNCTION guard_identity_l3_submission_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'identity L3 submissions must start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity L3 submission identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('upload_authorized', 'withdrawn')
      WHEN 'upload_authorized' THEN NEW.status IN ('uploaded', 'withdrawn')
      WHEN 'uploaded' THEN NEW.status IN ('processing', 'withdrawn')
      WHEN 'processing' THEN NEW.status IN ('pending_review', 'withdrawn')
      WHEN 'pending_review' THEN NEW.status IN ('approved', 'rejected', 'withdrawn')
      WHEN 'approved' THEN NEW.status IN ('revoked', 'expired')
      ELSE FALSE
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'invalid identity L3 status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('approved', 'rejected') AND
     (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by = NEW.user_id) THEN
    RAISE EXCEPTION 'identity L3 decision requires an independent reviewer' USING ERRCODE = '23514';
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND (
     NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR
     NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
     NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code OR
     NEW.approved_at IS DISTINCT FROM OLD.approved_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at
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

  -- Once bytes have been accepted, their identity and validation metadata cannot
  -- be swapped underneath a moderation decision. The sole permitted mutation is
  -- clearing the object key while atomically marking the media as purged.
  IF NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at AND NOT (
    OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
    AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
    AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired')
    AND NEW.status = OLD.status
  ) THEN
    RAISE EXCEPTION 'identity L3 media purge must be a one-way terminal-state operation' USING ERRCODE = '23514';
  END IF;

  IF OLD.status NOT IN ('draft', 'upload_authorized') AND (
    NEW.media_sha256 IS DISTINCT FROM OLD.media_sha256 OR
    NEW.media_mime_type IS DISTINCT FROM OLD.media_mime_type OR
    NEW.media_size_bytes IS DISTINCT FROM OLD.media_size_bytes OR
    NEW.media_duration_seconds IS DISTINCT FROM OLD.media_duration_seconds OR
    NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at OR
    (NEW.processing_completed_at IS DISTINCT FROM OLD.processing_completed_at AND NOT (
      OLD.status = 'uploaded' AND NEW.status = 'processing'
      AND OLD.processing_completed_at IS NULL AND NEW.processing_completed_at IS NOT NULL
    )) OR
    (NEW.storage_object_key IS DISTINCT FROM OLD.storage_object_key AND NOT (
      OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
      AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
      AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired')
      AND NEW.status = OLD.status
    ))
  ) THEN
    RAISE EXCEPTION 'identity L3 media metadata is immutable after upload' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_l3_submission_transition_guard
  BEFORE INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_submission_transition();

CREATE OR REPLACE FUNCTION record_identity_l3_submission_event()
RETURNS trigger LANGUAGE plpgsql AS $
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
    IF NEW.status = 'processing' AND NEW.processing_completed_at IS NOT NULL
       AND OLD.processing_completed_at IS NULL THEN
      INSERT INTO identity_l3_decision_events
        (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
      VALUES
        (NEW.id, NEW.user_id, event_actor, 'processing_started', OLD.status, NEW.status, event_reason),
        (NEW.id, NEW.user_id, event_actor, 'processing_completed', NEW.status, NEW.status, event_reason);
      RETURN NEW;
    END IF;

    next_event_type := CASE NEW.status
      WHEN 'upload_authorized' THEN 'upload_authorized'
      WHEN 'uploaded' THEN 'uploaded'
      WHEN 'processing' THEN 'processing_started'
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
        NEW.id, NEW.user_id,
        CASE WHEN NEW.status IN ('approved', 'rejected') THEN NEW.reviewed_by ELSE event_actor END,
        next_event_type, OLD.status, NEW.status,
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
$;

CREATE TRIGGER identity_l3_submission_event_recorder
  AFTER INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION record_identity_l3_submission_event();

CREATE OR REPLACE FUNCTION identity_l3_current_decision(p_user_id UUID)
RETURNS TABLE(status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE AS $
BEGIN
  RETURN QUERY
  SELECT s.status, s.expires_at
  FROM identity_l3_submissions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('approved', 'rejected', 'revoked', 'expired')
  ORDER BY COALESCE(s.approved_at, s.reviewed_at) DESC,
           COALESCE(s.revoked_at, s.approved_at, s.reviewed_at) DESC,
           s.created_at DESC, s.id DESC
  LIMIT 1
  FOR SHARE;
END;
$;

CREATE OR REPLACE FUNCTION identity_l3_has_active_approval(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $
DECLARE
  current_status TEXT;
  current_expiry TIMESTAMPTZ;
BEGIN
  SELECT decision.status, decision.expires_at
    INTO current_status, current_expiry
  FROM identity_l3_current_decision(p_user_id) AS decision;

  RETURN COALESCE(current_status = 'approved' AND current_expiry > NOW(), FALSE);
END;
$;

COMMENT ON TABLE identity_l3_submissions IS
  'L3 video workflow metadata only. Never store video bytes here; storage_object_key must reference private encrypted object storage.';
COMMENT ON TABLE identity_l3_decision_events IS
  'Append-only L3 workflow and moderation audit events. Avoid raw video, biometric data, document data and free-form personal information.';
COMMENT ON COLUMN identity_l3_submissions.expires_at IS
  'Approval expiry must be exactly six calendar months after approved_at; authorization must check this timestamp against database NOW().';
)
  ),
  CHECK (media_purged_at IS NULL OR storage_object_key IS NULL)
);

-- One live workflow per account; old decisions remain available for audit.
CREATE UNIQUE INDEX identity_l3_one_open_submission_per_user_uidx
  ON identity_l3_submissions(user_id)
  WHERE status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review');

CREATE INDEX identity_l3_moderation_queue_idx
  ON identity_l3_submissions(created_at, id)
  WHERE status = 'pending_review';
CREATE INDEX identity_l3_active_approval_idx
  ON identity_l3_submissions(user_id, expires_at DESC)
  WHERE status = 'approved';
CREATE INDEX identity_l3_expiry_idx
  ON identity_l3_submissions(expires_at, id)
  WHERE status = 'approved';
CREATE INDEX identity_l3_current_decision_idx
  ON identity_l3_submissions(
    user_id, (COALESCE(approved_at, reviewed_at)) DESC,
    (COALESCE(revoked_at, approved_at, reviewed_at)) DESC, created_at DESC, id DESC
  )
  WHERE status IN ('approved', 'rejected', 'revoked', 'expired');

CREATE TABLE identity_l3_decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES identity_l3_submissions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID, -- immutable audit identifier; intentionally survives actor account deletion
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'upload_authorized', 'uploaded', 'processing_started',
    'processing_completed', 'submitted_for_review', 'approved',
    'rejected', 'withdrawn', 'revoked', 'expired', 'media_purged'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN (
    'draft', 'upload_authorized', 'uploaded', 'processing',
    'pending_review', 'approved', 'rejected', 'withdrawn',
    'revoked', 'expired'
  )),
  reason_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (actor_user_id IS NULL OR actor_user_id <> user_id)
);
CREATE INDEX identity_l3_decision_events_submission_idx
  ON identity_l3_decision_events(submission_id, occurred_at, id);
CREATE INDEX identity_l3_decision_events_user_idx
  ON identity_l3_decision_events(user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_identity_l3_decision_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Permit only referential cleanup initiated by a parent-row cascade (for
  -- example, account deletion). Direct UPDATE/DELETE remains prohibited.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity L3 decision events are append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER identity_l3_decision_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_decision_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_decision_event_mutation();

CREATE OR REPLACE FUNCTION guard_identity_l3_submission_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'identity L3 submissions must start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity L3 submission identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('upload_authorized', 'withdrawn')
      WHEN 'upload_authorized' THEN NEW.status IN ('uploaded', 'withdrawn')
      WHEN 'uploaded' THEN NEW.status IN ('processing', 'withdrawn')
      WHEN 'processing' THEN NEW.status IN ('pending_review', 'withdrawn')
      WHEN 'pending_review' THEN NEW.status IN ('approved', 'rejected', 'withdrawn')
      WHEN 'approved' THEN NEW.status IN ('revoked', 'expired')
      ELSE FALSE
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'invalid identity L3 status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('approved', 'rejected') AND
     (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by = NEW.user_id) THEN
    RAISE EXCEPTION 'identity L3 decision requires an independent reviewer' USING ERRCODE = '23514';
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND (
     NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR
     NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
     NEW.decision_reason_code IS DISTINCT FROM OLD.decision_reason_code OR
     NEW.approved_at IS DISTINCT FROM OLD.approved_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at
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

  -- Once bytes have been accepted, their identity and validation metadata cannot
  -- be swapped underneath a moderation decision. The sole permitted mutation is
  -- clearing the object key while atomically marking the media as purged.
  IF NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at AND NOT (
    OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
    AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
    AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired')
    AND NEW.status = OLD.status
  ) THEN
    RAISE EXCEPTION 'identity L3 media purge must be a one-way terminal-state operation' USING ERRCODE = '23514';
  END IF;

  IF OLD.status NOT IN ('draft', 'upload_authorized') AND (
    NEW.media_sha256 IS DISTINCT FROM OLD.media_sha256 OR
    NEW.media_mime_type IS DISTINCT FROM OLD.media_mime_type OR
    NEW.media_size_bytes IS DISTINCT FROM OLD.media_size_bytes OR
    NEW.media_duration_seconds IS DISTINCT FROM OLD.media_duration_seconds OR
    NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at OR
    (NEW.processing_completed_at IS DISTINCT FROM OLD.processing_completed_at AND NOT (
      OLD.status = 'uploaded' AND NEW.status = 'processing'
      AND OLD.processing_completed_at IS NULL AND NEW.processing_completed_at IS NOT NULL
    )) OR
    (NEW.storage_object_key IS DISTINCT FROM OLD.storage_object_key AND NOT (
      OLD.media_purged_at IS NULL AND NEW.media_purged_at IS NOT NULL
      AND OLD.storage_object_key IS NOT NULL AND NEW.storage_object_key IS NULL
      AND OLD.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired')
      AND NEW.status = OLD.status
    ))
  ) THEN
    RAISE EXCEPTION 'identity L3 media metadata is immutable after upload' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_l3_submission_transition_guard
  BEFORE INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_submission_transition();

CREATE OR REPLACE FUNCTION record_identity_l3_submission_event()
RETURNS trigger LANGUAGE plpgsql AS $
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
    IF NEW.status = 'processing' AND NEW.processing_completed_at IS NOT NULL
       AND OLD.processing_completed_at IS NULL THEN
      INSERT INTO identity_l3_decision_events
        (submission_id, user_id, actor_user_id, event_type, from_status, to_status, reason_code)
      VALUES
        (NEW.id, NEW.user_id, event_actor, 'processing_started', OLD.status, NEW.status, event_reason),
        (NEW.id, NEW.user_id, event_actor, 'processing_completed', NEW.status, NEW.status, event_reason);
      RETURN NEW;
    END IF;

    next_event_type := CASE NEW.status
      WHEN 'upload_authorized' THEN 'upload_authorized'
      WHEN 'uploaded' THEN 'uploaded'
      WHEN 'processing' THEN 'processing_started'
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
        NEW.id, NEW.user_id,
        CASE WHEN NEW.status IN ('approved', 'rejected') THEN NEW.reviewed_by ELSE event_actor END,
        next_event_type, OLD.status, NEW.status,
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
$;

CREATE TRIGGER identity_l3_submission_event_recorder
  AFTER INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION record_identity_l3_submission_event();

CREATE OR REPLACE FUNCTION identity_l3_current_decision(p_user_id UUID)
RETURNS TABLE(status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE AS $
BEGIN
  RETURN QUERY
  SELECT s.status, s.expires_at
  FROM identity_l3_submissions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('approved', 'rejected', 'revoked', 'expired')
  ORDER BY COALESCE(s.approved_at, s.reviewed_at) DESC,
           COALESCE(s.revoked_at, s.approved_at, s.reviewed_at) DESC,
           s.created_at DESC, s.id DESC
  LIMIT 1
  FOR SHARE;
END;
$;

CREATE OR REPLACE FUNCTION identity_l3_has_active_approval(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $
DECLARE
  current_status TEXT;
  current_expiry TIMESTAMPTZ;
BEGIN
  SELECT decision.status, decision.expires_at
    INTO current_status, current_expiry
  FROM identity_l3_current_decision(p_user_id) AS decision;

  RETURN COALESCE(current_status = 'approved' AND current_expiry > NOW(), FALSE);
END;
$;

COMMENT ON TABLE identity_l3_submissions IS
  'L3 video workflow metadata only. Never store video bytes here; storage_object_key must reference private encrypted object storage.';
COMMENT ON TABLE identity_l3_decision_events IS
  'Append-only L3 workflow and moderation audit events. Avoid raw video, biometric data, document data and free-form personal information.';
COMMENT ON COLUMN identity_l3_submissions.expires_at IS
  'Approval expiry must be exactly six calendar months after approved_at; authorization must check this timestamp against database NOW().';
