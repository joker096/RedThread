-- Keep automatic adjustment reconciliation aligned with Paddle's
-- actual lifecycle: subscription.created records captured (paid) recurring
-- payment evidence; transaction.completed records fully processed payment.
CREATE OR REPLACE FUNCTION require_verified_automatic_paddle_adjustment_link()
RETURNS trigger LANGUAGE plpgsql AS $automatic_adjustment_link$
BEGIN
  IF NEW.status = 'resolved'
     AND NEW.resolution_source = 'automatic_provider_transaction_link'
     AND (
       NEW.reason_code <> 'transaction_owner_unlinked'
       OR NOT EXISTS (
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
                AND (
                  (webhook.event_type = 'transaction.completed' AND transaction.status = 'completed')
                  OR (
                    webhook.event_type = 'subscription.created'
                    AND transaction.status = 'paid'
                    AND transaction.subscription_id IS NOT NULL
                    AND transaction.customer_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM users AS owner
                      WHERE owner.id = transaction.user_id
                        AND owner.paddle_subscription_id = transaction.subscription_id
                        AND owner.paddle_customer_id = transaction.customer_id
                    )
                  )
                )
               WHERE transaction.transaction_id = source.transaction_id
                 AND transaction.user_id IS NOT NULL
                 AND transaction.plan IS NOT NULL
             ) AS candidate
             WHERE candidate.transaction_id = source.transaction_id
               AND candidate.status = 'linked'
           ) = 1
           AND (
             EXISTS (
               SELECT 1
               FROM paddle_checkout_attempts AS linked_attempt
               WHERE linked_attempt.transaction_id = source.transaction_id
                 AND linked_attempt.status = 'linked'
             )
             OR EXISTS (
               SELECT 1
               FROM paddle_checkout_attempt_history AS linked_history
               WHERE linked_history.transaction_id = source.transaction_id
                 AND linked_history.status = 'linked'
             )
             OR EXISTS (
               SELECT 1
               FROM paddle_transaction_events AS linked_transaction
               JOIN paddle_webhook_events AS webhook
                 ON webhook.event_id = linked_transaction.event_id
                AND (
                  (webhook.event_type = 'transaction.completed' AND linked_transaction.status = 'completed')
                  OR (
                    webhook.event_type = 'subscription.created'
                    AND linked_transaction.status = 'paid'
                    AND linked_transaction.subscription_id IS NOT NULL
                    AND linked_transaction.customer_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM users AS owner
                      WHERE owner.id = linked_transaction.user_id
                        AND owner.paddle_subscription_id = linked_transaction.subscription_id
                        AND owner.paddle_customer_id = linked_transaction.customer_id
                    )
                  )
                )
               WHERE linked_transaction.transaction_id = source.transaction_id
                 AND linked_transaction.user_id IS NOT NULL
                 AND linked_transaction.plan IN ('1month', '3months')
             )
           )
       )
     ) THEN
    RAISE EXCEPTION 'automatic Paddle adjustment resolution requires one verified provider transaction owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$automatic_adjustment_link$;


CREATE CONSTRAINT TRIGGER paddle_adjustment_reconciliation_automatic_link_guard
  AFTER INSERT OR UPDATE ON paddle_adjustment_reconciliation_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_verified_automatic_paddle_adjustment_link();

COMMENT ON FUNCTION require_verified_automatic_paddle_adjustment_link() IS
  'Requires automatic reconciliation to have one unique linked checkout owner; recurring ledger evidence may be transaction.completed or a paid subscription.created event tied to the same stored subscription/customer.';
