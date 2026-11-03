-- A revoked lifetime entitlement must retain the exact provider-backed
-- reason that removed it. Do not allow a revoked projection with no reason or
-- an arbitrary free-form reason to enter the financial evidence ledger.
ALTER TABLE paddle_lifetime_entitlements
  DROP CONSTRAINT IF EXISTS paddle_lifetime_entitlements_check;

ALTER TABLE paddle_lifetime_entitlements
  ADD CONSTRAINT paddle_lifetime_entitlements_status_reason_check
  CHECK (
    (status = 'active' AND revoke_reason IS NULL)
    OR
    (status = 'revoked' AND revoke_reason IS NOT NULL
      AND revoke_reason IN ('paddle_full_refund', 'paddle_chargeback'))
  );

COMMENT ON CONSTRAINT paddle_lifetime_entitlements_status_reason_check
  ON paddle_lifetime_entitlements IS
  'Active lifetime entitlements have no revocation reason; revoked entitlements must retain a recognized Paddle full-refund or chargeback reason.';
