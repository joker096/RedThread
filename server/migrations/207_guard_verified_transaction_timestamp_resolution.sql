-- Extend the database-level automatic-resolution guard for quarantined
-- transaction timestamps. Genuine provider lifecycle conflicts remain ineligible.
-- Follow the webhook/migration lock order: users, checkout attempts/history,
-- transaction evidence, then reconciliation cases.
LOCK TABLE users, paddle_checkout_attempts, paddle_checkout_attempt_history,
  paddle_transaction_events, paddle_adjustment_reconciliation_cases
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION require_verified_automatic_paddle_adjustment_link()
RETURNS trigger LANGUAGE plpgsql AS $automatic_adjustment_link$
BEGIN
  IF NEW.status = 'resolved'
     AND NEW.resolution_source = 'automatic_provider_transaction_link'
     AND (
       (
         NEW.reason_code = 'transaction_owner_unlinked'
         AND NOT EXISTS (
           SELECT 1
           FROM paddle_adjustment_events AS source
           WHERE source.event_id = NEW.event_id
             AND (
               SELECT COUNT(DISTINCT (candidate.user_id, candidate.plan))
               FROM (
                 SELECT user_id, transaction_id, plan, status
                 FROM paddle_checkout_attempts
                 UNION ALL
                 SELECT user_id, transaction_id, plan, status
                 FROM paddle_checkout_attempt_history
                 UNION ALL
                 SELECT transaction.user_id, transaction.transaction_id, transaction.plan, 'linked'::text AS status
                 FROM paddle_transaction_events AS transaction
                 JOIN paddle_webhook_events AS webhook
                   ON webhook.event_id = transaction.event_id
                  AND webhook.event_type = 'transaction.completed'
                 WHERE transaction.transaction_id = source.transaction_id
                   AND transaction.status = 'completed'
                   AND transaction.user_id IS NOT NULL
                   AND transaction.plan IS NOT NULL
               ) AS candidate
               WHERE candidate.transaction_id = source.transaction_id
                 AND candidate.status = 'linked'
             ) = 1
             AND (
               EXISTS (
                 SELECT 1 FROM paddle_checkout_attempts AS linked_attempt
                 WHERE linked_attempt.transaction_id = source.transaction_id
                   AND linked_attempt.status = 'linked'
               )
               OR EXISTS (
                 SELECT 1 FROM paddle_checkout_attempt_history AS linked_history
                 WHERE linked_history.transaction_id = source.transaction_id
                   AND linked_history.status = 'linked'
               )
               OR EXISTS (
                 SELECT 1 FROM paddle_transaction_events AS linked_transaction
                 JOIN paddle_webhook_events AS webhook
                   ON webhook.event_id = linked_transaction.event_id
                  AND webhook.event_type = 'transaction.completed'
                 WHERE linked_transaction.transaction_id = source.transaction_id
                   AND linked_transaction.status = 'completed'
                   AND linked_transaction.user_id IS NOT NULL
                   AND linked_transaction.plan IN ('1month', '3months')
               )
             )
         )
       )
       OR (
         NEW.reason_code = 'invalid_transaction_timestamp'
         AND NOT EXISTS (
           SELECT 1
           FROM paddle_webhook_events AS original
           WHERE original.event_id = NEW.event_id
             AND original.event_type IN (
               'transaction.paid', 'transaction.completed', 'transaction.canceled'
             )
             AND NEW.provider_transaction_id IS NOT NULL
             AND (
               SELECT COUNT(DISTINCT candidate.user_id)
               FROM (
                 SELECT user_id, transaction_id FROM paddle_checkout_attempts
                 UNION ALL
                 SELECT user_id, transaction_id FROM paddle_checkout_attempt_history
                 UNION ALL
                 SELECT user_id, transaction_id FROM paddle_transaction_events
               ) AS candidate
               WHERE candidate.transaction_id = NEW.provider_transaction_id
                 AND candidate.user_id IS NOT NULL
             ) = 1
             AND EXISTS (
               SELECT 1
               FROM paddle_transaction_events AS evidence
               JOIN paddle_webhook_events AS verified
                 ON verified.event_id = evidence.event_id
               WHERE evidence.transaction_id = NEW.provider_transaction_id
                 AND evidence.user_id IS NOT NULL
                 AND evidence.status IN ('completed', 'canceled')
                 AND evidence.occurred_at IS NOT NULL
                 AND (
                   (evidence.status = 'completed' AND verified.event_type = 'transaction.completed')
                   OR (evidence.status = 'canceled' AND verified.event_type = 'transaction.canceled')
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM (
                     SELECT user_id, transaction_id FROM paddle_checkout_attempts
                     UNION ALL
                     SELECT user_id, transaction_id FROM paddle_checkout_attempt_history
                     UNION ALL
                     SELECT user_id, transaction_id FROM paddle_transaction_events
                   ) AS unique_owner
                   WHERE unique_owner.transaction_id = NEW.provider_transaction_id
                     AND unique_owner.user_id = evidence.user_id
                 )
                 AND (
                   EXISTS (
                     SELECT 1 FROM paddle_checkout_attempts AS attempt
                     WHERE attempt.transaction_id = NEW.provider_transaction_id
                       AND attempt.user_id = evidence.user_id
                       AND attempt.plan IS NOT DISTINCT FROM evidence.plan
                       AND attempt.status IN ('linked', 'completed', 'canceled')
                     UNION ALL
                     SELECT 1 FROM paddle_checkout_attempt_history AS archived
                     WHERE archived.transaction_id = NEW.provider_transaction_id
                       AND archived.user_id = evidence.user_id
                       AND archived.plan IS NOT DISTINCT FROM evidence.plan
                       AND archived.status IN ('linked', 'completed', 'canceled')
                   )
                   OR EXISTS (
                     SELECT 1 FROM users AS owner
                     WHERE owner.id = evidence.user_id
                       AND (
                         (evidence.customer_id IS NOT NULL AND owner.paddle_customer_id = evidence.customer_id)
                         OR (evidence.subscription_id IS NOT NULL AND owner.paddle_subscription_id = evidence.subscription_id)
                       )
                   )
                 )
             )
         )
       )
       OR NEW.reason_code NOT IN ('transaction_owner_unlinked', 'invalid_transaction_timestamp')
     ) THEN
    RAISE EXCEPTION 'automatic Paddle reconciliation requires verified transaction ownership and lifecycle evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$automatic_adjustment_link$;

COMMENT ON FUNCTION require_verified_automatic_paddle_adjustment_link() IS
  'Automatic transaction-owner-unlinked adjustment closure requires the original verified linked-checkout evidence. Invalid transaction timestamp cases may close only with timestamp-valid completed/canceled ledger evidence and one unique checkout or subscription owner. Genuine provider lifecycle conflicts cannot be auto-closed.';
