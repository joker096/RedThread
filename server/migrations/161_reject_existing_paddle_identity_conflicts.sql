-- Migration 159 added cross-table guards for new Paddle transaction claims.
-- Before those guards become the only protection, fail closed if retained rows
-- already disagree about the owner or plan of one provider transaction.
DO $$
BEGIN
  IF EXISTS (
    SELECT transaction_id
    FROM (
      SELECT transaction_id, user_id, plan
      FROM paddle_checkout_attempts
      WHERE transaction_id IS NOT NULL
      UNION ALL
      SELECT transaction_id, user_id, plan
      FROM paddle_checkout_attempt_history
      WHERE transaction_id IS NOT NULL
      UNION ALL
      SELECT transaction_id, user_id, plan
      FROM paddle_transaction_events
      WHERE transaction_id IS NOT NULL
    ) AS retained_identity
    GROUP BY transaction_id
    HAVING COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) > 1
       OR COUNT(DISTINCT plan) FILTER (WHERE plan IS NOT NULL) > 1
  ) THEN
    RAISE EXCEPTION 'conflicting existing Paddle transaction owner or plan evidence; reconcile before migration 161'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

COMMENT ON FUNCTION guard_paddle_checkout_transaction_global_uniqueness() IS
  'Serializes provider transaction claims with a transaction-scoped advisory lock and enforces owner and plan consistency across current attempts, archived history, and the append-only transaction ledger; migration 161 rejects pre-existing cross-source identity conflicts.';
