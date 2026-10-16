CREATE TABLE IF NOT EXISTS profile_passes (
  passer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passed_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (passer_id, passed_user_id),
  CHECK (passer_id <> passed_user_id)
);
CREATE INDEX IF NOT EXISTS profile_passes_target_idx ON profile_passes (passed_user_id, passer_id);
