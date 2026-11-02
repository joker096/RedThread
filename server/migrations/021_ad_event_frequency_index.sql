-- Supports the rolling 24-hour per-user/per-campaign frequency-cap query for both
-- impressions and clicks. INCLUDE keeps the aggregate query covered without
-- storing event payloads or adding any user-identifying columns.
CREATE INDEX IF NOT EXISTS ad_events_user_campaign_window_idx
  ON ad_events (user_id, campaign_id, created_at DESC)
  INCLUDE (event_type);
