-- Validate consent-history snapshots at the database boundary as well as in the API.
-- NOT VALID avoids blocking deployment on legacy rows while enforcing every new insert.
CREATE OR REPLACE FUNCTION is_valid_ad_consent_history_preferences(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  category_key TEXT;
  category_value JSONB;
  allowed_categories CONSTANT TEXT[] := ARRAY['fashion', 'beauty', 'travel', 'general_local'];
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN
    RETURN FALSE;
  END IF;

  IF value - ARRAY[
    'adsConsent', 'dateOffersConsent', 'weddingOffersConsent',
    'marriagePlanningOptIn', 'categoryConsents'
  ] <> '{}'::jsonb THEN
    RETURN FALSE;
  END IF;

  FOREACH category_key IN ARRAY ARRAY[
    'adsConsent', 'dateOffersConsent', 'weddingOffersConsent', 'marriagePlanningOptIn'
  ] LOOP
    IF NOT (value ? category_key)
      OR jsonb_typeof(value -> category_key) <> 'boolean' THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  IF NOT (value ? 'categoryConsents')
    OR jsonb_typeof(value -> 'categoryConsents') <> 'object' THEN
    RETURN FALSE;
  END IF;

  IF value -> 'adsConsent' = 'false'::jsonb AND (
    value -> 'dateOffersConsent' <> 'false'::jsonb
    OR value -> 'weddingOffersConsent' <> 'false'::jsonb
    OR value -> 'marriagePlanningOptIn' <> 'false'::jsonb
    OR value -> 'categoryConsents' <> '{}'::jsonb
  ) THEN
    RETURN FALSE;
  END IF;

  IF value -> 'marriagePlanningOptIn' = 'true'::jsonb
    AND value -> 'weddingOffersConsent' <> 'true'::jsonb THEN
    RETURN FALSE;
  END IF;

  FOR category_key, category_value IN
    SELECT key, val FROM jsonb_each(value -> 'categoryConsents') AS entry(key, val)
  LOOP
    IF NOT (category_key = ANY(allowed_categories))
      OR jsonb_typeof(category_value) <> 'boolean' THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

ALTER TABLE ad_consent_history
  ADD CONSTRAINT ad_consent_history_preferences_valid
  CHECK (is_valid_ad_consent_history_preferences(preferences)) NOT VALID;

COMMENT ON FUNCTION is_valid_ad_consent_history_preferences(JSONB) IS
  'Checks the complete normalized consent snapshot schema and parent-child consent invariants at the database boundary.';
