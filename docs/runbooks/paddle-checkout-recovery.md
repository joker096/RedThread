# Paddle checkout recovery runbook

## Safety boundary

This worker is sandbox-only. It rejects any `PADDLE_ENVIRONMENT` other than `sandbox` and uses only `https://sandbox-api.paddle.com`. It does not create transactions, cancel transactions, issue refunds, or grant entitlements.

Dry-run is the default. Dry-run performs provider reads and read-only candidate selection; it does not claim leases or write recovery state. To persist verified recovery outcomes, explicitly set:

```sh
PADDLE_ENVIRONMENT=sandbox
PADDLE_CHECKOUT_RECOVERY_APPLY=true
```

Never set the apply flag for Production. Do not add a live API key to test or staging environments.

## Required configuration

- `DATABASE_URL`
- Sandbox `PADDLE_API_KEY` with `transaction.read`
- `PADDLE_ENVIRONMENT=sandbox`
- `PADDLE_PRICE_ID_1MONTH`, `PADDLE_PRICE_ID_3MONTHS`, `PADDLE_PRICE_ID_LIFETIME`
- `PADDLE_EXPECTED_CURRENCY_CODE` (three-letter ISO currency)
- `PADDLE_EXPECTED_AMOUNT_MINOR_1MONTH`
- `PADDLE_EXPECTED_AMOUNT_MINOR_3MONTHS`
- `PADDLE_EXPECTED_AMOUNT_MINOR_LIFETIME`

The expected amounts are integer minor units and must be reviewed against the approved sandbox price configuration before apply mode. Missing or malformed expected values fail closed. A transaction with a different currency, amount, price, quantity, account, plan, or attempt ID is never attached.

## Operation

1. Apply database migrations in the sandbox environment.
2. Run `npm run paddle:checkout-recovery` without the apply flag. Inspect the structured result and verify expected financial configuration.
3. For sandbox recovery only, set `PADDLE_CHECKOUT_RECOVERY_APPLY=true` and run the worker under the normal process supervisor.
4. The worker processes one stale attempt at a time, uses a 90-second lease with a fencing token, and limits each provider scan to five pages of 30 transactions.
5. It retries missing/incomplete provider results with bounded exponential backoff. After five attempts, unresolved attempts move to `reconciliation_required` for manual review.
6. Paid/completed/billed transactions are quarantined for webhook reconciliation; the worker never grants Premium. Reprocess the signed webhook through the durable inbox path or use the established manual reconciliation procedure.

## Queries and alert conditions

Inspect queue depth and age:

```sql
SELECT status, COUNT(*) AS attempts,
       MIN(created_at) AS oldest_created_at,
       MAX(recovery_attempt_count) AS max_recovery_attempts
FROM paddle_checkout_attempts
WHERE status IN ('creating', 'reconciliation_required')
GROUP BY status;
```

Inspect lease and retry state without exposing customer data:

```sql
SELECT attempt_id, status, recovery_attempt_count,
       recovery_lease_expires_at, recovery_next_attempt_at,
       recovery_last_checked_at, recovery_last_error_code
FROM paddle_checkout_attempts
WHERE status IN ('creating', 'reconciliation_required')
ORDER BY created_at;
```

Alert on any `creating` attempt older than 10 minutes, expired recovery leases, repeated `provider_page_limit_reached`, or growth in `reconciliation_required`. Do not include API keys, checkout URLs, email addresses, or raw provider payloads in logs.

## Stop / rollback

Stop the worker process to halt recovery. No provider-side state is changed by stopping it. If recovery configuration is uncertain, unset `PADDLE_CHECKOUT_RECOVERY_APPLY`; dry-run remains read-only. Do not clear leases manually while a worker may still be running; allow the lease to expire or stop all worker instances first.
