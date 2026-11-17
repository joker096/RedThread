# Paddle Sandbox worker operations

## Activation gate

These workers are intentionally excluded from the default Compose deployment and are available only through the `paddle-sandbox` profile.

Do not start either worker until Vow has written Paddle approval for the relevant dating-app payment features, the Sandbox account is configured, and the sandbox acceptance checklist has been reviewed. This runbook does not authorize Production, live charges, or deployment to the VPS.

The workers reject a non-sandbox `PADDLE_ENVIRONMENT`. Do not supply live credentials. No Stripe integration is supported or permitted.

## Services and network boundaries

- `paddle-webhook-inbox-worker` consumes events that the API has already signature-verified and durably inserted into the inbox. It performs local database processing only and is attached to the internal `backend` network. It receives the configured Paddle Price IDs but no API key, webhook secret, or browser token.
- `paddle-checkout-recovery-worker` performs bounded, read-only GET requests to Paddle Sandbox. It is attached to `backend` and `egress`, has no published ports, and uses the sandbox-only API host allowlist in its code. Its default `PADDLE_CHECKOUT_RECOVERY_APPLY=false` mode does not claim leases or write recovery state.
- Both services run as the unprivileged API image user, drop Linux capabilities, enable `no-new-privileges`, wait for migrations, and remain stopped unless the profile is explicitly selected.
- Gift-payment event processing and reconciliation are not included here: the gift provider registry and read-only adapter remain intentionally unconfigured. The gift webhook must continue to fail closed with HTTP 503 until a provider, verifier, account, environment, and adapter have been separately reviewed.

## Required Sandbox environment

Keep these values in the deployment secret environment, never in Git or chat:

- `PADDLE_ENVIRONMENT=sandbox`
- `PADDLE_API_KEY` with only the `transaction.read` permission required for checkout recovery
- `PADDLE_PRICE_ID_1MONTH`, `PADDLE_PRICE_ID_3MONTHS`, and `PADDLE_PRICE_ID_LIFETIME` as applicable
- `PADDLE_EXPECTED_CURRENCY_CODE` (three-letter ISO code)
- `PADDLE_EXPECTED_AMOUNT_MINOR_1MONTH`
- `PADDLE_EXPECTED_AMOUNT_MINOR_3MONTHS`
- `PADDLE_EXPECTED_AMOUNT_MINOR_LIFETIME`

The API itself separately requires the Sandbox API key, webhook signing secret, and client token before it accepts Paddle checkout/webhook traffic. Do not pass the webhook secret or client token to either worker.

## Start and observe

Start only the inbox worker when verified Sandbox events are being received:

```sh
docker compose --profile paddle-sandbox up -d paddle-webhook-inbox-worker
docker compose logs --tail=100 paddle-webhook-inbox-worker
```

Start checkout recovery in read-only dry-run mode first:

```sh
docker compose --profile paddle-sandbox up -d paddle-checkout-recovery-worker
docker compose logs --tail=100 paddle-checkout-recovery-worker
```

Review its structured metrics and candidate outcomes. Confirm exact Sandbox price IDs, currency, and integer minor-unit amounts before considering apply mode. Missing or malformed expected values fail closed.

Only after explicit operator review, Sandbox-only approval, and confirmation that the values above match the Sandbox catalog, enable local recovery writes:

```sh
PADDLE_CHECKOUT_RECOVERY_APPLY=true docker compose --profile paddle-sandbox up -d --force-recreate paddle-checkout-recovery-worker
```

Apply mode changes only local checkout-recovery records after exact provider identity and financial-snapshot matching. It does not create/cancel transactions, issue refunds, or grant Premium. Paid/completed transactions remain held for signed webhook reconciliation.

To return to dry-run mode, unset the shell override and set `PADDLE_CHECKOUT_RECOVERY_APPLY=false` in the secret environment, then recreate the service:

```sh
docker compose --profile paddle-sandbox up -d --force-recreate paddle-checkout-recovery-worker
```

Stop workers:

```sh
docker compose --profile paddle-sandbox stop paddle-webhook-inbox-worker paddle-checkout-recovery-worker
```

## Incident response

Stop the affected worker immediately if it makes an unexpected network request, logs secrets or personal data, processes an unverified event, or produces a financial identity mismatch. Preserve aggregate metrics, event IDs/hashes, lease generations, and quarantine reason codes. Do not manually clear leases while a worker may still be running.

Do not use this runbook to activate Production. Production payment processing remains disabled pending a separate approved design, compliance review, provider authorization, and a new Draft PR with independent acceptance tests.


## Webhook inbox queue health and alert thresholds

The inbox worker emits aggregate-only metrics every 60 seconds. It never selects or logs event payloads, event IDs, customer identifiers, or user data for these metrics.

Counters:
- `pendingCount`: verified events waiting for their first processing attempt.
- `retryCount`: events waiting for a scheduled retry.
- `processingCount`: events currently held under a worker lease.
- `expiredLeaseCount`: processing rows whose lease expired and can be reclaimed.
- `deadLetterCount`: events quarantined after bounded processing attempts or an identity conflict.
- `dueCount`: pending/retry events whose next attempt time has arrived.
- `oldestUnfinishedAgeSeconds`: age of the oldest pending, retry, or processing event.

The worker logs alert markers when any of these conditions are present:
- `dead_letter_events_present`: inspect the dead-letter reason code and linked reconciliation case; do not replay blindly.
- `expired_worker_leases_present`: check worker restarts, database connectivity, and whether a previous worker is still alive before manual intervention.
- `oldest_event_over_5m`: investigate sustained processing delay.
- `backlog_over_100_due_events`: inspect worker health and database capacity.

These are operational alert signals, not automatic repair commands. Never delete or manually reset queue rows/leases to silence an alert. Preserve append-only conflict evidence and use the existing reconciliation procedures for financial identity mismatches.
