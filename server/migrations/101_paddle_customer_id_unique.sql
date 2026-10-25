-- Customer identity must be unique even when concurrent verified webhooks race.
-- Run after 099_paddle_billing.sql creates paddle_customer_id.
-- If legacy duplicates exist, fail the migration for explicit reconciliation rather
-- than choosing an account silently or weakening identity isolation.
CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_customer_id_unique
  ON users (paddle_customer_id)
  WHERE paddle_customer_id IS NOT NULL;
