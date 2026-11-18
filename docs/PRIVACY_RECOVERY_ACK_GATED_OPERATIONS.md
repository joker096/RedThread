# ACK-gated privacy recovery operations

Status: foundation implemented on an isolated Draft branch; domain routes are not yet migrated.

## Required ordering

1. The caller supplies a stable idempotency UUID and stable UTC `occurredAt`.
2. `runAckGatedPrivacyRecoveryOperation` commits an immutable, pseudonymized intent row in `privacy_recovery_operations`.
3. The same event UUID and exact payload are sent to the independent Ledger.
4. A validated ACK containing the matching event ID and a positive sequence is required.
5. Only then does a second PostgreSQL transaction lock the operation row, revalidate current domain conditions through the route callback, apply the domain mutation, and mark the operation applied atomically.

Ledger outage, rejection, malformed ACK, or timeout prevents the domain callback from running. If the Ledger accepted an event but the response timed out, retrying the same operation UUID resubmits the same event identity. If PostgreSQL fails after ACK, the durable intent remains and the same operation can be resumed.

## Invariants and integration contract

- Operation UUID is also the immutable Ledger event UUID.
- Reusing an operation UUID with a different event payload is rejected.
- The operation row is committed before contacting the Ledger.
- Domain changes and the `applied` transition share one PostgreSQL transaction.
- Route callbacks must re-check ownership, authorization, consent version, eligibility and any required locks after the ACK. No stale pre-ACK validation is sufficient.
- Callbacks must not make network calls or other non-transactional side effects. Existing external billing workflows need their own idempotent reconciliation boundary.
- This is a durable saga, not a distributed atomic transaction.
- The existing transactional outbox remains available for non-gating audit/notification events, but must not be mistaken for proof that the remote Ledger accepted a privacy-critical operation.

## Remaining work

Migrate every privacy-critical route (account erasure, voice consent/erasure, photo erasure, L3 consent withdrawal, ad consent revocation and gift consent withdrawal) to this protocol; ensure clients reuse an idempotency key on retry; add route-level PostgreSQL integration tests for each event type and each failure window; add an operation resumer; then run CI, Browser E2E, native builds and Android/iOS virtual-device smoke checks on one exact HEAD. No Production, VPS, external Ledger provisioning or payment activation is part of this branch.
