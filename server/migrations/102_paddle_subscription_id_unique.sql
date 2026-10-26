-- Application-level NOT EXISTS checks do not serialize concurrent webhooks.
-- Enforce the subscription-to-account identity invariant at the database boundary,
-- just as migration 101 does for Paddle customer IDs. If legacy duplicates exist,
-- fail visibly and require explicit reconciliation rather than choosing an owner.
CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_subscription_id_unique
  ON users (paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;
