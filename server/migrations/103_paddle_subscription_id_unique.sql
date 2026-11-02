-- Application-level NOT EXISTS checks cannot serialize concurrent verified webhooks.
-- Enforce the Paddle subscription-to-account identity invariant at the database
-- boundary. Fail visibly if legacy duplicates exist; never choose an owner silently.
CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_subscription_id_unique
  ON users (paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;
