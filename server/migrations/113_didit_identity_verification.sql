-- Store only opaque Didit session identifiers and webhook decision metadata.
-- Documents, selfies, extracted identity fields and biometric templates are never stored.
CREATE TABLE IF NOT EXISTS identity_verifications (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'didit' CHECK (provider = 'didit'),
  provider_session_id UUID UNIQUE,
  workflow_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'rejected')),
  provider_status TEXT
    CHECK (provider_status IS NULL OR provider_status IN (
      'Not Started', 'In Progress', 'Approved', 'Declined', 'In Review',
      'Awaiting User', 'Resubmitted', 'Expired', 'Abandoned', 'Kyc Expired'
    )),
  provider_environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (provider_environment = 'sandbox'),
  provider_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS identity_verifications_status_updated_idx
  ON identity_verifications (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS identity_verification_events (
  event_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_session_id UUID NOT NULL,
  provider_event_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS identity_verification_events_session_idx
  ON identity_verification_events (provider_session_id, provider_event_at DESC);
CREATE INDEX IF NOT EXISTS identity_verification_events_user_idx
  ON identity_verification_events (user_id);

COMMENT ON TABLE identity_verifications IS
  'Minimal Didit sandbox identity-verification state only; no identity documents, images, extracted fields or biometric data are stored.';
COMMENT ON TABLE identity_verification_events IS
  'Didit webhook idempotency and ordering metadata only; no verification payload or personal data is stored.';
