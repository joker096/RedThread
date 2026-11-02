-- A verified L2 state must always be backed by the persisted live Didit session
-- that produced the provider's final Approved verdict. Sandbox and incomplete
-- provider records must never satisfy the authorization gate.
ALTER TABLE identity_verifications
  ADD CONSTRAINT identity_verifications_verified_requires_live_approved_session
  CHECK (
    status <> 'verified'
    OR (
      provider = 'didit'
      AND provider_environment = 'live'
      AND provider_status = 'Approved'
      AND provider_session_id IS NOT NULL
    )
  ) NOT VALID;

-- Validate existing rows before allowing the migration to complete. If historical
-- data violates the invariant, deployment must stop rather than silently preserve
-- an authorization state that cannot be tied to a live approved provider session.
ALTER TABLE identity_verifications
  VALIDATE CONSTRAINT identity_verifications_verified_requires_live_approved_session;
