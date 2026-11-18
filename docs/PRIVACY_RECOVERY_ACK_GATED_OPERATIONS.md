# ACK-gated privacy recovery operations

Status: foundation implemented on an isolated Draft branch; domain routes are not yet migrated.

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
- **Gift order consent withdrawal:** the order ID is a natural one-time resource identity, but the apply transaction must reacquire pair/user/order safety locks, re-evaluate withdrawal eligibility and revoke the address-vault entry atomically with order cancellation and audit events.

Do not treat a stale preflight result as authorization to apply after ACK. If state changed while the Ledger request was in flight, abort the apply transaction and leave the operation acknowledged for explicit reconciliation; never silently apply to a different lifecycle.

## Remaining work

Migrate every privacy-critical route (account erasure, voice consent/erasure, photo erasure, L3 consent withdrawal, ad consent revocation and gift consent withdrawal) to this protocol; ensure clients reuse an idempotency key on retry; add route-level PostgreSQL integration tests for each event type and each failure window; add an operation resumer; then run CI, Browser E2E, native builds and Android/iOS virtual-device smoke checks on one exact HEAD. No Production, VPS, external Ledger provisioning or payment activation is part of this branch.
