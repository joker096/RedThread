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
    CHECK (provider_environment IN ('sandbox', 'live')),
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




-- Aggregate monthly reservations are intentionally not linked to user accounts,
-- so account deletion cannot reset the free-tier spending guard.
CREATE TABLE IF NOT EXISTS didit_monthly_quota_usage (
  month_start DATE PRIMARY KEY,
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count BETWEEN 0 AND 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Record explicit user consent before sending identity data to Didit.
CREATE TABLE IF NOT EXISTS identity_verification_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_version TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'didit'),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS identity_verification_consents_user_idx
  ON identity_verification_consents (user_id, consented_at DESC);

-- Reserve one slot before calling Didit Live so concurrent requests cannot
-- exceed Vow's local free-tier cap. Ambiguous provider timeouts keep the slot.
CREATE TABLE IF NOT EXISTS identity_verification_session_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_session_id UUID UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'created')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS identity_verification_session_reservations_monthly_idx
  ON identity_verification_session_reservations (environment, created_at)
  WHERE status IN ('reserved', 'created');

COMMENT ON TABLE didit_monthly_quota_usage IS
  'Non-identifying UTC monthly count of Vow-originated Didit Live session reservations; deliberately survives account deletion to prevent quota reset.';
COMMENT ON TABLE identity_verification_consents IS
  'Append-only record of user consent version and timestamp before sending data to Didit; no identity media or extracted personal data.';
CREATE UNIQUE INDEX IF NOT EXISTS identity_verification_one_reservation_per_user_uidx
  ON identity_verification_session_reservations (user_id) WHERE status = 'reserved';

COMMENT ON TABLE identity_verifications IS
  'Minimal Didit identity-verification state; no identity documents, images, extracted fields or biometric data are stored.';
COMMENT ON TABLE identity_verification_session_reservations IS
  'Counts Vow-originated Didit sessions for a local monthly free-tier cap; unresolved requests keep their reserved slot to avoid paid overages.';
COMMENT ON TABLE identity_verification_events IS
  'Didit webhook idempotency and ordering metadata only; no verification payload or personal data is stored.';
