ALTER TABLE users
  ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS paddle_subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS paddle_price_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_subscription_id_unique
  ON users (paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS paddle_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
