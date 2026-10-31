CREATE TABLE IF NOT EXISTS ad_campaigns (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  advertiser_id UUID NOT NULL,
  advertiser_verified BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'paused', 'rejected', 'expired')),
  category TEXT NOT NULL,
  creative_version TEXT NOT NULL,
  creative_approved BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_country_codes TEXT[] NOT NULL DEFAULT '{}',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (category <> '')
);

CREATE INDEX IF NOT EXISTS ad_campaigns_status_window_idx
  ON ad_campaigns (status, starts_at, ends_at);

COMMENT ON TABLE ad_campaigns IS
  'Server-owned approval registry. Client-supplied campaign IDs are never authorization evidence.';
