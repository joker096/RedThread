CREATE TABLE IF NOT EXISTS private_photo_purge_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  last_error_code TEXT,
  CHECK (length(storage_path) BETWEEN 1 AND 2048)
);

CREATE INDEX IF NOT EXISTS private_photo_purge_queue_due_idx
  ON private_photo_purge_queue (next_attempt_at, created_at);

COMMENT ON TABLE private_photo_purge_queue IS
  'Durable retry queue for deleting private photo files after their database metadata is removed. Paths are validated against PHOTO_STORAGE_DIR by the purge worker.';
