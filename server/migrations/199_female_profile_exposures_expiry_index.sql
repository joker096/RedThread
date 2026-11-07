-- Support bounded global deletion of exposure rows from prior UTC days.
-- The leading date column keeps the privacy-retention scan indexable.
CREATE INDEX IF NOT EXISTS female_profile_exposures_expiry_idx
  ON female_profile_exposures (exposure_date, user_id, profile_user_id);
