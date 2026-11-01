-- Store only provider identifiers and decision metadata. Identity documents and biometric
-- templates remain with Sumsub and are never copied into Vow's database.
CREATE TABLE IF NOT EXISTS identity_verifications (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'sumsub' CHECK (provider = 'sumsub'),
  applicant_id TEXT UNIQUE,
  level_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'rejected')),
  review_answer TEXT
    CHECK (review_answer IS NULL OR review_answer IN ('GREEN', 'RED')),
  provider_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (applicant_id IS NULL OR LENGTH(BTRIM(applicant_id)) BETWEEN 1 AND 200),
  CHECK (LENGTH(BTRIM(level_name)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS identity_verifications_status_updated_idx
  ON identity_verifications (status, updated_at DESC);

COMMENT ON TABLE identity_verifications IS
  'Minimal Sumsub identity-verification state only; no identity documents, images, or biometric data are stored.';
