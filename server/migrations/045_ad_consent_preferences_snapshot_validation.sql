-- Apply the same normalized consent schema at the mutable preference table boundary.
-- NOT VALID preserves legacy rows but checks every newly inserted or updated snapshot.
ALTER TABLE ad_consent_preferences
  ADD CONSTRAINT ad_consent_preferences_snapshot_valid
  CHECK (
    is_valid_ad_consent_history_preferences(
      jsonb_build_object(
        'adsConsent', ads_consent,
        'dateOffersConsent', date_offers_consent,
        'weddingOffersConsent', wedding_offers_consent,
        'marriagePlanningOptIn', marriage_planning_opt_in,
        'categoryConsents', category_consents
      )
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT ad_consent_preferences_snapshot_valid ON ad_consent_preferences IS
  'Enforces supported category keys, boolean category values, and parent-child consent invariants for new or updated preference rows.';
