-- PostgreSQL CHECK constraints accept UNKNOWN, not only TRUE. Migration 116's
-- predicate can therefore admit a verified row when provider_status is NULL
-- and the remaining fields are valid. Force the verified branch to be TRUE.
ALTER TABLE identity_verifications
  DROP CONSTRAINT IF EXISTS identity_verifications_verified_requires_live_approved_session;

ALTER TABLE identity_verifications
  ADD CONSTRAINT identity_verifications_verified_requires_live_approved_session
  CHECK (
    status <> 'verified'
    OR (
      (
        provider = 'didit'
        AND provider_environment = 'live'
        AND provider_status = 'Approved'
        AND provider_session_id IS NOT NULL
      ) IS TRUE
    )
  ) NOT VALID;

ALTER TABLE identity_verifications
  VALIDATE CONSTRAINT identity_verifications_verified_requires_live_approved_session;
