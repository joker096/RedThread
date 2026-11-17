# Gift payment reconciliation (sandbox-only)

## Safety boundary

The worker has no default provider adapter. Do not deploy or invoke it until a reviewed sandbox adapter is explicitly injected by the application composition root. The adapter contract is strictly read-only `lookup({ providerKey, providerReference, idempotencyKey })`; it must query the provider's existing transaction state and return the exact provider identity, amount, currency, and a terminal provider-observed status. It must never create, authorize, capture, void, cancel, or refund a transaction. Unknown, pending, mismatched, or incomplete responses are not success.

The worker does not create payments, issue void/refund commands, cancel provider transactions, fulfil gifts, or grant entitlements. It only records a provider-confirmed terminal state already observed by the adapter. Never configure Production credentials. No provider-specific gift payment integration is currently enabled.

## Verified event inbox contract

Migration 214 adds `record_verified_gift_provider_event(...)`. Its caller MUST verify the provider signature against the exact raw request bytes, enforce timestamp/replay limits, and validate provider account/environment before calling it. The SQL function does not perform cryptographic verification and must never be exposed as an unauthenticated public endpoint.

- A new verified event returns `inserted`.
- An identical redelivery (same provider, event ID, hash, type and occurrence time) returns `duplicate`.
- Reuse of an event ID with different content returns `conflict`, stores only the competing hash and event metadata in append-only conflict evidence, and quarantines the original inbox row if it is still pending.
- Raw webhook bodies, signatures, personal data and payment credentials are never persisted by this inbox.
- Conflicting event evidence is append-only. Do not delete, rewrite, or merge it manually.

The inbox function does not update gift order/payment state and does not assert event ordering. A webhook event is a reconciliation signal only. The read-only provider lookup remains the source of truth for terminal payment state; stale or out-of-order webhook deliveries must never directly roll back an order state. The actual HTTP signature-verification route and its integration tests remain unimplemented.

## Operational health

Query the aggregate view; it contains counters only and does not expose account or recipient data:

```sql
SELECT * FROM gift_payment_reconciliation_health;
```

Signals to alert on:
- `due_tasks > 0` for longer than the worker polling SLO.
- `expired_leases > 0` across two consecutive polling intervals.
- `dead_letter_tasks > 0` (manual review required).
- `tasks_missing_payment_identity > 0` (manual review; never infer identity).
- `quarantined_provider_events > 0` (verify signature/identity conflict handling).

## Read-only investigation

```sql
SELECT id, status, attempt_count, next_attempt_at, last_error_code,
       lease_generation, lease_expires_at, dead_lettered_at
FROM gift_payment_reconciliation_tasks
ORDER BY created_at DESC
LIMIT 100;

SELECT processing_status, COUNT(*)
FROM gift_payment_provider_event_inbox
GROUP BY processing_status;

SELECT provider_key, COUNT(*)
FROM gift_payment_provider_event_conflicts
GROUP BY provider_key;
```

Do not copy provider references or recipient data into tickets or logs. Do not edit completed tasks or append-only identity/event evidence.

## Recovery

1. Disable the worker process if it is repeatedly failing, making unexpected provider calls, or producing identity/amount mismatches.
2. Keep the provider adapter read-only. Preserve the task, lease generation, event hash, and audit evidence.
3. Review dead-lettered or quarantined records manually against the provider's sandbox dashboard using the least-privilege operator account.
4. Correct application code or adapter behavior in a Draft PR. Do not rewrite identity rows, re-use a provider reference, or force task completion.
5. Re-run migrations, CI, Browser E2E, and PostgreSQL concurrency/crash tests on one exact commit SHA before considering deployment.

## Lease semantics

Claims use `FOR UPDATE SKIP LOCKED`. Each claim increments `attempt_count` and `lease_generation`, and rotates the opaque lease token. An expired lease can be reclaimed. Heartbeat and completion must match both token and generation and require a still-live lease; stale workers cannot finish after a takeover. Retry exhaustion is recorded with `dead_lettered_at` and is excluded from future claims.

## Current limitations

- No gift payment provider adapter is configured.
- No HTTP webhook route performs provider signature verification or calls the verified-event inbox function yet.
- Verified event ingestion does not enqueue work or change payment status; that must be wired only to the existing read-only reconciliation process.
- The current health view supplies aggregate SQL metrics; external alert delivery is not configured.
- Production activation and live financial operations are prohibited.
