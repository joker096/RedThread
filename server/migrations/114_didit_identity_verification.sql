-- Replace the unreleased Sumsub adapter with Didit V3 sandbox state.
-- No identity documents, selfies, extracted fields, face templates or scores are stored.
ALTER TABLE identity_verifications
  DROP CONSTRAINT IF EXISTS identity_verifications_provider_check,
  DROP CONSTRAINT IF EXISTS identity_verifications_review_answer_check;
ALTER TABLE identity_verifications RENAME COLUMN applicant_id TO provider_session_id;
ALTER TABLE identity_verifications RENAME COLUMN level_name TO workflow_id;
ALTER TABLE identity_verifications DROP COLUMN review_answer;
ALTER TABLE identity_verifications
  ALTER COLUMN provider SET DEFAULT 'didit',
  ADD CONSTRAINT identity_verifications_provider_check CHECK (provider = 'didit'),
  ADD COLUMN provider_status TEXT CHECK (provider_status IS NULL OR provider_status IN (
    'Not Started', 'In Progress', 'Approved', 'Declined', 'In Review',
    'Awaiting User', 'Resubmitted', 'Expired', 'Abandoned', 'Kyc Expired'
  )),
  ADD COLUMN provider_environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (provider_environment = 'sandbox');
UPDATE identity_verifications SET status = 'pending', provider_session_id = NULL, provider_status = NULL, provider_event_at = NULL, provider_environment = 'sandbox', updated_at = NOW();
CREATE TABLE IF NOT EXISTS identity_verification_events (
  event_id UUID PRIMARY KEY,
  provider_session_id UUID NOT NULL,
  provider_event_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS identity_verification_events_session_idx
  ON identity_verification_events (provider_session_id, provider_event_at DESC);
COMMENT ON TABLE identity_verifications IS
  'Minimal Didit sandbox identity-verification state only; no identity documents, images, extracted fields or biometric data are stored.';
COMMENT ON TABLE identity_verification_events IS
  'Didit webhook idempotency and ordering metadata only; no verification payload or personal data is stored.';
