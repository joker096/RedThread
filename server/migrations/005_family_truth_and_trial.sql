-- Relationship intentions, mandatory child-status disclosure, and women-first-day trial.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS family_format TEXT NOT NULL DEFAULT 'open_to_both',
  ADD COLUMN IF NOT EXISTS has_children BOOLEAN,
  ADD COLUMN IF NOT EXISTS children_disclosure_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wants_children TEXT NOT NULL DEFAULT 'discuss'
    CHECK (wants_children IN ('yes', 'no', 'discuss', 'unsure')),
  ADD COLUMN IF NOT EXISTS children_living_arrangement TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (children_living_arrangement IN ('with_me', 'shared_custody', 'with_other_parent', 'not_applicable', 'prefer_to_discuss')),
  ADD COLUMN IF NOT EXISTS family_values TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_relationship_intent_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_relationship_intent_check
  CHECK (relationship_intent IN ('marriage_family', 'serious_relationship', 'family_without_marriage'));

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_family_format_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_family_format_check
  CHECK (family_format IN ('marriage', 'cohabitation', 'open_to_both'));

-- Existing members must confirm child-status disclosure before becoming visible again.
UPDATE profiles SET is_visible = FALSE
WHERE children_disclosure_confirmed_at IS NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS female_trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_verified_phone_unique
  ON users (phone_e164)
  WHERE phone_verified_at IS NOT NULL AND phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_trial_lookup_idx
  ON users (female_trial_ends_at, premium_until);

ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS user_reports_category_check;
ALTER TABLE user_reports ADD CONSTRAINT user_reports_category_check
  CHECK (category IN ('spam', 'fake_profile', 'harassment', 'safety', 'children_misrepresentation', 'duplicate_profile', 'other'));

COMMENT ON COLUMN profiles.has_children IS 'Self-declared child status; do not infer from photos or reports.';
COMMENT ON COLUMN profiles.children_disclosure_confirmed_at IS 'Timestamp when the user explicitly confirmed their child-status disclosure.';
COMMENT ON COLUMN users.female_trial_ends_at IS '24-hour full-feature trial for female accounts; this is access expiry, not permission to charge.';
COMMENT ON COLUMN users.phone_verified_at IS 'Only verified phone numbers are used as a duplicate-account uniqueness signal.';
