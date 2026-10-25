-- Customer identity must be unique even when concurrent verified webhooks race.
-- Migration 099 creates paddle_customer_id; migration 100 removes legacy Stripe columns.
-- Keep this as a separate later migration so fresh installs apply it in the right order.
-- If legacy duplicates exist, fail the migration for explicit reconciliation rather
-- than choosing an account silently or weakening identity isolation.
CREATE UNIQUE INDEX IF NOT EXISTS users_paddle_customer_id_unique
  ON users (paddle_customer_id)
  WHERE paddle_customer_id IS NOT NULL;
