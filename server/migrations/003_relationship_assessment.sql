ALTER TABLE profile_preferences
  ADD COLUMN IF NOT EXISTS max_distance_km INTEGER CHECK (max_distance_km IS NULL OR max_distance_km BETWEEN 1 AND 20000),
  ADD COLUMN IF NOT EXISTS minimum_financial_alignment SMALLINT NOT NULL DEFAULT 0 CHECK (minimum_financial_alignment BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS exclude_unanswered_assessments BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS relationship_assessments (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL,
  assessment_version SMALLINT NOT NULL DEFAULT 1,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(answers) = 'object')
);

CREATE INDEX IF NOT EXISTS relationship_assessments_updated_idx
  ON relationship_assessments (updated_at DESC);

COMMENT ON TABLE relationship_assessments IS
  'Private declared relationship preferences; never a diagnosis, moral rating, or proof of deception.';
