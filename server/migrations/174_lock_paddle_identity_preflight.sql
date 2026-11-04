-- Re-run the cross-table identity preflight while all three evidence
-- sources are write-locked. This closes the window in migration 159 between
-- its initial duplicate scan and activation of the guards.
LOCK TABLE paddle_checkout_attempts, paddle_checkout_attempt_history, paddle_transaction_events
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT transaction_id
    FROM (
      SELECT transaction_id FROM paddle_checkout_attempts WHERE transaction_id IS NOT NULL
      UNION ALL
      SELECT transaction_id FROM paddle_checkout_attempt_history WHERE transaction_id IS NOT NULL
    ) AS checkout_claims
    GROUP BY transaction_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Paddle transaction claims already exist across current and archived checkout attempts; reconcile before migration 174'
      USING ERRCODE = '23514';
  END IF;

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
    RAISE EXCEPTION 'conflicting Paddle transaction owner or plan evidence already exists across retained sources; reconcile before migration 174'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
