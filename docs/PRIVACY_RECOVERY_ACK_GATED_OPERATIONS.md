# ACK-gated privacy recovery operations

Status: foundation implemented on an isolated Draft branch; gift-order consent withdrawal and ad-consent revocation are migrated, with route-level PostgreSQL concurrency coverage still pending.

## Required ordering

1. The caller supplies a stable operation UUID. For server-owned one-time resource transitions, `derivePrivacyRecoveryOperationId` derives a deterministic UUIDv4 from the event type, subject, resource and lifecycle generation. The generation must identify the same consent grant / resource lifecycle across retries; it must change only for a genuinely new lifecycle, never per HTTP attempt. The first committed intent chooses `occurred_at`; later attempts load and reuse that exact immutable payload.
2. `runAckGatedPrivacyRecoveryOperation` commits an immutable, pseudonymized intent row in `privacy_recovery_operations`.
3. The same event UUID and exact payload are sent to the independent Ledger. The original `occurred_at` is retained from the first persisted intent, even if later retries happen at a different time.
4. The Ledger response echoes `event_id`; the client validates that exact ID plus a positive sequence. Both first-write and duplicate ACKs return the same event ID.
5. Only then does a second PostgreSQL transaction lock the operation row, revalidate current domain conditions through the route callback, apply the domain mutation, and mark the operation applied atomically.

Ledger outage, rejection, malformed ACK, or timeout prevents the domain callback from running. If the Ledger accepted an event but the response timed out, retrying the same operation UUID resubmits the same event identity. If PostgreSQL fails after ACK, the durable intent remains and the same operation can be resumed.

## Invariants and integration contract

- Operation UUID is also the immutable Ledger event UUID and must be UUIDv4.
- Deterministic operation identity is domain-separated (`vow-privacy-recovery-operation-v1`) and stable across retries. Callers must not use request timestamps, random UUIDs, or mutable state as the generation component.
- The deterministic helper is a foundation only; it does not itself make any route ACK-gated.
- PostgreSQL enforces monotonic state transitions only: pending → acknowledged → applied. Pending cannot jump directly to applied; acknowledged/applied states cannot be downgraded; the persisted Ledger sequence and acknowledgement timestamp cannot be rewritten after ACK.
- The database constraint and trigger are the final guardrail even if a future route or maintenance script bypasses the application helper.
- Reusing an operation UUID with a different event type, subject, resource or schema version is rejected; the original persisted `occurred_at` is reused rather than treated as a conflict.
- The operation row is committed before contacting the Ledger.
- Domain changes and the `applied` transition share one PostgreSQL transaction.
- Route callbacks must re-check ownership, authorization, consent version, eligibility and any required locks after the ACK. No stale pre-ACK validation is sufficient.
- Callbacks must not make network calls or other non-transactional side effects. Existing external billing workflows need their own idempotent reconciliation boundary.
- This is a durable saga, not a distributed atomic transaction.
- The existing transactional outbox remains available for non-gating audit/notification events, but must not be mistaken for proof that the remote Ledger accepted a privacy-critical operation.

## Route migration audit

The current `server/index.js` handlers cannot safely call the new runner from inside their existing transaction. The runner opens independent PostgreSQL transactions for intent, ACK persistence and domain apply. Route integration must therefore release pre-ACK locks, preserve only immutable identifiers / lifecycle generation, obtain the Ledger ACK, and reacquire locks plus revalidate all domain predicates inside `apply(client)`.

- **Account erasure:** the handler performs Paddle cancellation/reconciliation before its deletion transaction and holds account-safety serialization around that workflow. Keep provider cancellation outside the ACK-gated DB callback; after ACK, revalidate active account state, subscription reconciliation state and private-media purge prerequisites before anonymization/deletion. A retry identity must be stable for the account-erasure lifecycle.
- **Voice intro withdrawal + clip erasure:** the handler currently locks the consent row and clip rows, emits one event per clip plus a consent event, then withdraws consent and queues/deletes clips in the same transaction. Capture the consent grant timestamp/version and clip IDs as preflight facts, but reacquire locks and verify the same grant and clip set after ACK. Each clip erasure and consent withdrawal need separate stable operation identities.
- **Profile photo erasure:** profile update currently combines profile changes and asset deletion. Only the removed asset IDs should be ACK-gated; re-read ownership and current references after ACK so a concurrently retained/replaced photo is not deleted.
- **Identity L3 withdrawal:** preserve token revocation, submission state changes and private-media purge queueing as one DB apply transaction. Revalidate the active consent/submission generation after ACK; do not revoke capabilities before ACK.
- **Ad consent revocation:** use the exact consent grant/version being revoked as the operation generation. Re-lock and compare that version after ACK before writing the preference/history rows.
- **Gift order consent withdrawal — migrated:** the route now performs a lock-free preflight, derives a stable operation ID from the gift order lifecycle, obtains and persists the matching Ledger ACK, then reacquires participant safety locks and revalidates account/order eligibility inside the apply transaction. Order cancellation, address-vault ciphertext revocation, audit event and deduplicated notification are committed atomically. PostgreSQL route-level failure/concurrency tests are still required before treating this migration as validated.

Do not treat a stale preflight result as authorization to apply after ACK. If state changed while the Ledger request was in flight, abort the apply transaction and leave the operation acknowledged for explicit reconciliation; never silently apply to a different lifecycle.

## Remaining work

Migrate the remaining privacy-critical routes (account erasure, voice consent/erasure, photo erasure, L3 consent withdrawal and ad consent revocation) to this protocol; add PostgreSQL route-level failure/concurrency tests for the migrated gift route and each remaining event type; ensure clients reuse an idempotency key on retry; add route-level PostgreSQL integration tests for each event type and each failure window; add an operation resumer; then run CI, Browser E2E, native builds and Android/iOS virtual-device smoke checks on one exact HEAD. No Production, VPS, external Ledger provisioning or payment activation is part of this branch.


## Ad consent revocation migration

The `PUT /api/ads/consent` route now sends every detected withdrawal of an
existing ad purpose through the ACK-gated operation coordinator. The preflight
read is lock-free; it captures the exact consent row lifecycle using the stored
policy version and `updated_at`. The deterministic operation ID is scoped to
that lifecycle, so HTTP retries reuse the same intent rather than generating a
new event.

After the independent Ledger ACK is durably stored, the apply transaction
reacquires the active-account and consent-row locks and compares the complete
consent snapshot with the preflight snapshot. If a re-consent or another
preference write won during the Ledger round-trip, the callback aborts with
`ad_consent_state_changed_retry`; the acknowledged operation remains available
for reconciliation and cannot revoke the newer consent. Preference upsert and
history insertion remain in the same PostgreSQL transaction.

Non-revoking writes retain their normal transaction, but repeat the revocation
check after acquiring the row lock. If a concurrent write turns the request
into a revocation, the route returns HTTP 409 and requires a retry through the
ACK-gated path. No database lock is held while waiting for the Ledger.

Unit coverage now exercises master/dependent/category withdrawal detection,
stable lifecycle generation, and snapshot-change detection. A dedicated
PostgreSQL-backed route/concurrency test is still required before this route
can be considered fully integration-verified.
