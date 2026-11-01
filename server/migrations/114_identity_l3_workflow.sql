-- L3 video submissions store metadata and opaque object keys only.
-- Video bytes must live in a separately configured private encrypted object store.
CREATE TABLE identity_l3_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'upload_authorized', 'uploaded', 'processing',
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
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
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
    status NOT IN ('uploaded', 'processing', 'pending_review', 'approved', 'rejected')
    OR (
      storage_object_key IS NOT NULL AND length(storage_object_key) BETWEEN 1 AND 512
      AND media_sha256 IS NOT NULL AND media_mime_type IS NOT NULL
      AND media_size_bytes IS NOT NULL AND media_duration_seconds IS NOT NULL
      AND uploaded_at IS NOT NULL
    )
  ),
  CHECK (
    status <> 'approved'
    OR (
      reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND approved_at IS NOT NULL AND expires_at = approved_at + INTERVAL '6 months'
      AND reviewed_by <> user_id
    )
  ),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
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

CREATE TABLE identity_l3_decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES identity_l3_submissions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_l3_submission_transition_guard
  BEFORE INSERT OR UPDATE ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_submission_transition();

COMMENT ON TABLE identity_l3_submissions IS
  'L3 video workflow metadata only. Never store video bytes here; storage_object_key must reference private encrypted object storage.';
COMMENT ON TABLE identity_l3_decision_events IS
  'Append-only L3 workflow and moderation audit events. Avoid raw video, biometric data, document data and free-form personal information.';
COMMENT ON COLUMN identity_l3_submissions.expires_at IS
  'Approval expiry must be exactly six calendar months after approved_at; authorization must check this timestamp against database NOW().';
