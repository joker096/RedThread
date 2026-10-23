ALTER TABLE users
  ADD COLUMN IF NOT EXISTS revenuecat_premium_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revenuecat_premium_lifetime BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS revenuecat_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS revenuecat_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  environment TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
