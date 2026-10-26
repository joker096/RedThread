-- Retention cleanup removes old engagement events; this index keeps each batch bounded.
CREATE INDEX IF NOT EXISTS ad_events_created_at_cleanup_idx
  ON ad_events (created_at, event_id);

COMMENT ON COLUMN ad_events.created_at IS
  'Event timestamp used for frequency controls and a maximum 90-day operational retention window.';
