CREATE TABLE IF NOT EXISTS api_rate_limit_counters (
  key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 0)
);
CREATE INDEX IF NOT EXISTS api_rate_limit_counters_window_idx ON api_rate_limit_counters (window_started_at);

CREATE TABLE IF NOT EXISTS moderation_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moderator_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS moderation_audit_log_created_idx ON moderation_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_audit_log_target_idx ON moderation_audit_log (target_type, target_id, created_at DESC);
COMMENT ON TABLE moderation_audit_log IS 'Append-only record of moderator/admin decisions; do not store full report text or sensitive content here.';
