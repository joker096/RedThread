-- Count profiles actually issued to a free-tier woman, not search requests.
-- Exposure dates are derived from PostgreSQL's UTC clock.
CREATE TABLE female_profile_exposures (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Keep the opaque target UUID through account deletion so deleting a viewed
  -- profile cannot refund another woman's already-consumed daily exposure slot.
  profile_user_id UUID NOT NULL,
  exposure_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (user_id, exposure_date, profile_user_id),
  CONSTRAINT female_profile_exposures_no_self CHECK (user_id <> profile_user_id)
);

COMMENT ON TABLE female_profile_exposures IS
  'Unique profile cards actually issued to free-tier women per UTC calendar day; retries and pagination are idempotent.';
