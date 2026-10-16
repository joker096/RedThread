ALTER TABLE users
  ADD COLUMN IF NOT EXISTS premium_lifetime BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_subscription_idx ON users (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
