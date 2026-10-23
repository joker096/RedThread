-- Remove legacy Stripe-specific storage after switching all billing flows to Paddle.
-- Keep migration 011 in history because deployed databases may already have applied it.
DROP INDEX IF EXISTS users_stripe_subscription_idx;

ALTER TABLE users
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;
