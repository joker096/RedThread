# Gift payment reconciliation (sandbox-only)

## Safety boundary

The reconciliation worker has no default provider adapter. Any future adapter must be explicitly reviewed and injected, and its lookup contract must remain read-only. No gift provider, verifier, account, or environment is currently configured. Paddle remains sandbox-only pending written approval; Production and Stripe are prohibited.

The webhook route accepts exact raw bytes and delegates signature, timestamp, and replay verification to an injected verifier. It rejects any provider configuration other than sandbox. The inbox stores only the raw-body SHA-256 plus bounded verified routing metadata: provider account, environment, provider reference, amount in minor units, currency, event ID/type and timestamps. Raw payloads, signatures, recipient data and payment credentials are never stored.

## Fenced inbox processor

Migrations 215–217 add a separate event processor lease, independent from the order reconciliation task lease. Migration 216 scopes every claim to one explicitly configured provider key; workers with multiple providers must select the key explicitly. Migration 217 rejects partial routing metadata:

- Claims one pending event using `FOR UPDATE SKIP LOCKED`.
- Every claim increments attempt count and fencing generation and rotates the opaque lease token.
- Expired leases can be reclaimed after a worker restart. A stale worker cannot mark an event processed or quarantined.
- Exact matching uses `provider_key + provider_reference` against the immutable `gift_payment_attempt_identity` row.
- Provider account and environment are checked again against the explicitly injected sandbox provider configuration.
- Amount and currency must exactly equal the immutable payment-attempt snapshot.
- Unknown references, missing provider configuration, account/environment mismatches, and amount/currency mismatches are quarantined.
- A successful match records the immutable `matched_attempt_id` and atomically makes an already-existing, retryable order reconciliation task due. It does not create lifecycle work from a webhook alone.
- The processor never calls a provider, changes order/payment state, captures/refunds/voids a transaction, fulfils a gift, or grants an entitlement. The read-only reconciliation worker remains responsible for provider lookup and the separately fenced order-state transition.

An event ID reused with different content remains append-only conflict evidence and quarantines the original pending event. No conflict resolution may overwrite the original hash or metadata.

## Operational health

Aggregate counters only; no account or recipient data is exposed:

```sql
SELECT * FROM gift_payment_reconciliation_health;
SELECT processing_status, COUNT(*)
FROM gift_payment_provider_event_inbox
GROUP BY processing_status;
SELECT quarantine_code, COUNT(*)
FROM gift_payment_provider_event_inbox
WHERE processing_status = 'quarantined'
GROUP BY quarantine_code;
```

Alert on due reconciliation tasks, expired leases, dead-lettered tasks, quarantined events, and tasks missing immutable payment identity. Do not copy provider references or recipient data into tickets or logs.

## Recovery and validation

1. Stop the worker if it produces unexpected network calls, payment mutations, or integrity mismatches.
2. Preserve event hashes, verified metadata, attempt identity, task state, lease generation and quarantine evidence.
3. Investigate quarantined events against the provider's sandbox dashboard using a least-privilege operator account.
4. Correct code only in a Draft PR; never rewrite immutable identity or event evidence.
5. Require CI, Browser E2E, PostgreSQL concurrency/restart tests, and exact checkout-SHA verification on the same final commit before considering the change verified.

## Current limitations

- The provider registry remains empty, so the public gift webhook route continues to fail closed with HTTP 503.
- No provider-specific cryptographic verifier or gift-payment provider adapter is enabled.
- The processor is not wired into an executable deployment composition.
- External alert delivery and retention policy review remain outstanding.
- Production activation and live financial operations are prohibited.
