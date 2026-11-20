-- A durable, non-destructive guard while an account-erasure Ledger ACK is pending.
-- Authenticated requests are denied while this marker is set, except a retry of
-- DELETE /api/account, which must be able to resume the same operation UUID.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deletion_pending_at TIMESTAMPTZ;

COMMENT ON COLUMN users.deletion_pending_at IS
  'Fail-closed account-erasure guard set before releasing account locks for the remote privacy Ledger ACK; retained across retries until the account is tombstoned.';
