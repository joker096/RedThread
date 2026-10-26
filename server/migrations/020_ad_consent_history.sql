-- Append-only history of explicit ad-consent choices. Do not store IP addresses,
-- user-agent strings, chat data, or inferred profile traits in this table.
CREATE TABLE IF NOT EXISTS ad_consent_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_version SMALLINT NOT NULL CHECK (consent_version > 0),
  preferences JSONB NOT NULL CHECK (jsonb_typeof(preferences) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    preferences ? 'adsConsent'
    AND jsonb_typeof(preferences->'adsConsent') = 'boolean'
  )
);

CREATE INDEX IF NOT EXISTS ad_consent_history_user_time_idx
  ON ad_consent_history (user_id, recorded_at DESC);

COMMENT ON TABLE ad_consent_history IS
  'Append-only application audit of explicit ad-consent choices; user deletion removes associated history.';
COMMENT ON COLUMN ad_consent_history.preferences IS
  'Normalized public preference snapshot at the time of the choice; never include request metadata or profile/chat content.';
