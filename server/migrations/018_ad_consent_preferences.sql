-- Explicit, revocable advertising preferences. No consent is inferred from profile or match activity.
-- The table is intentionally not read by ad delivery until a consent-management API and UI are implemented.
CREATE TABLE IF NOT EXISTS ad_consent_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ads_consent BOOLEAN NOT NULL DEFAULT FALSE,
  date_offers_consent BOOLEAN NOT NULL DEFAULT FALSE,
  wedding_offers_consent BOOLEAN NOT NULL DEFAULT FALSE,
  marriage_planning_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  category_consents JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(category_consents) = 'object'),
  consent_version SMALLINT NOT NULL DEFAULT 1 CHECK (consent_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (wedding_offers_consent = FALSE OR ads_consent = TRUE),
  CHECK (date_offers_consent = FALSE OR ads_consent = TRUE),
  CHECK (marriage_planning_opt_in = FALSE OR wedding_offers_consent = TRUE)
);

COMMENT ON TABLE ad_consent_preferences IS
  'Explicit per-user advertising consent preferences. All options default off; not connected to ad delivery until consent API/UI is implemented.';
COMMENT ON COLUMN ad_consent_preferences.category_consents IS
  'Per-category opt-ins only; unknown keys must be ignored by application code.';
