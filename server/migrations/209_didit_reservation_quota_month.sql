-- Persist the exact UTC quota month with each reservation so a definitive
-- provider rejection returns the slot to the same aggregate counter it incremented.
ALTER TABLE identity_verification_session_reservations
  ADD COLUMN IF NOT EXISTS quota_month_start DATE;

UPDATE identity_verification_session_reservations
SET quota_month_start = date_trunc('month', created_at AT TIME ZONE 'UTC')::date
WHERE environment = 'live' AND quota_month_start IS NULL;

COMMENT ON COLUMN identity_verification_session_reservations.quota_month_start IS
  'UTC month whose aggregate Didit quota counter was incremented for this reservation; NULL for sandbox.';
