COMMENT ON TABLE paddle_transaction_events IS
  'Append-only minimal history of Paddle transaction.paid, transaction.completed and transaction.canceled webhooks plus captured recurring payments evidenced by subscription.created. The paid state is distinct from completed and may progress to completed; full webhook payloads and payment credentials are never stored.';

COMMENT ON COLUMN paddle_transaction_events.status IS
  'Paddle transaction lifecycle snapshot: paid (payment captured, processing may continue), completed (fully processed), or canceled. A transaction may progress paid -> completed but cannot move between paid/completed and canceled.';
