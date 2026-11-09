CREATE TABLE IF NOT EXISTS profile_voice_intros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('audio/mp4', 'audio/aac', 'audio/x-m4a')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 64 AND 2097152),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 15000 AND 25000),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at TIMESTAMPTZ,
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT profile_voice_intros_storage_filename_check
    CHECK (storage_path ~ '(^|/)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$'),
  CONSTRAINT profile_voice_intros_review_state_check
    CHECK (
      (review_status = 'pending' AND reviewed_at IS NULL AND reviewer_id IS NULL)
      OR
      (review_status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS profile_voice_intros_review_queue_idx
  ON profile_voice_intros (created_at, id)
  WHERE review_status = 'pending';

CREATE TABLE IF NOT EXISTS private_voice_intro_purge_queue (
  id BIGSERIAL PRIMARY KEY,
  storage_path TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT private_voice_intro_purge_storage_filename_check
    CHECK (storage_path ~ '(^|/)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$')
);

CREATE INDEX IF NOT EXISTS private_voice_intro_purge_due_idx
  ON private_voice_intro_purge_queue (next_attempt_at, created_at);

COMMENT ON TABLE profile_voice_intros IS
  'Encrypted 15–25 second profile voice introductions. Only approved clips are visible to eligible profile viewers.';
COMMENT ON TABLE private_voice_intro_purge_queue IS
  'Durable retry queue for deleting encrypted private voice introduction files after replacement or account deletion.';
