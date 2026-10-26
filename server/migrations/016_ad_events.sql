CREATE TABLE IF NOT EXISTS ad_events (
  event_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL CHECK (campaign_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ad_events_user_campaign_recent_idx
  ON ad_events (user_id, campaign_id, created_at DESC)
  WHERE event_type = 'impression';
CREATE INDEX IF NOT EXISTS ad_events_campaign_type_recent_idx
  ON ad_events (campaign_id, event_type, created_at DESC);

COMMENT ON TABLE ad_events IS 'Minimal authenticated ad engagement events for frequency control; not proof of billable provider impressions or revenue.';
