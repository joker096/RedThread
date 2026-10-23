-- Remove obsolete provider-specific storage after switching billing to Paddle.
-- This is safe for both fresh databases and databases that already applied the old billing migration.
DROP INDEX IF EXISTS users_stripe_subscription_idx;

ALTER TABLE users
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;
