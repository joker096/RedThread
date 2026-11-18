# ACK-gated privacy recovery operations

Status: foundation implemented on an isolated Draft branch. Gift-order consent withdrawal, ad-consent revocation, L3 consent withdrawal, voice-intro erasure/consent withdrawal, profile-photo erasure, and account erasure are migrated. PostgreSQL route-level failure/concurrency coverage remains incomplete.

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

- **Account erasure — migrated:** Paddle checkout/subscription cancellation and reconciliation remain before the privacy Ledger request. Both session-level checkout and safety advisory locks are released before waiting for the Ledger ACK. Before releasing locks, the route sets a durable `users.deletion_pending_at` guard and moves the account to `suspended`; ordinary sessions, login and mobile refresh are blocked, while only DELETE /api/account may retry. The apply callback reacquires transaction-scoped checkout, safety and account-reuse locks, then revalidates account identity/creation generation, billing/checkout state and L3 private-media prerequisites before tombstoning. Photo/voice purge queues, gift safety holds, consent-history cleanup, anonymization and account-reuse restriction are committed atomically with the operation's `applied` state. A deterministic operation ID is scoped to the account creation generation.
- **Voice intro withdrawal + clip erasure:** the handler currently locks the consent row and clip rows, emits one event per clip plus a consent event, then withdraws consent and queues/deletes clips in the same transaction. Capture the consent grant timestamp/version and clip IDs as preflight facts, but reacquire locks and verify the same grant and clip set after ACK. Each clip erasure and consent withdrawal need separate stable operation identities.
- **Profile photo erasure — migrated:** the route captures exact removed photo IDs, storage paths and `created_at` values before ACK without holding row locks. A batch ACKs every removed asset before mutation. The apply transaction reacquires the account-safety lock and compares the complete immutable asset set; it then updates the profile, removes asset metadata and enqueues physical file purges atomically. A changed asset set aborts with a retryable conflict.
- **Identity L3 withdrawal — migrated:** token revocation, submission state changes and private-media purge queueing share one apply transaction; the active consent/submission generation is revalidated after ACK.
- **Ad consent revocation — migrated:** the exact consent grant/version is the operation generation; the route re-locks and compares the complete snapshot after ACK before writing preference/history rows.
- **Gift order consent withdrawal — migrated:** the route now performs a lock-free preflight, derives a stable operation ID from the gift order lifecycle, obtains and persists the matching Ledger ACK, then reacquires participant safety locks and revalidates account/order eligibility inside the apply transaction. Order cancellation, address-vault ciphertext revocation, audit event and deduplicated notification are committed atomically. PostgreSQL route-level failure/concurrency tests are still required before treating this migration as validated.

Do not treat a stale preflight result as authorization to apply after ACK. If state changed while the Ledger request was in flight, abort the apply transaction and leave the operation acknowledged for explicit reconciliation; never silently apply to a different lifecycle.

## Remaining work

- Add PostgreSQL-backed route-level tests for every migrated path: Ledger outage before ACK, database failure after ACK, stale lifecycle change during ACK, duplicate HTTP retry, and concurrent requests.
- Add a durable operation resumer/reconciler for `pending` and `acknowledged` rows, with bounded retries and operator-visible terminal failures.
- Audit any other privacy-critical event paths outside `server/index.js` and ensure they cannot bypass ACK-gated operations.
- Run CI and Browser E2E on the same exact HEAD with checkout SHA verified; then Android/iOS native builds and virtual-device smoke checks on the validated SHA.

No Production, VPS, external Ledger provisioning or payment activation is part of this branch.


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


## L3 consent withdrawal migration

The `DELETE /api/identity/l3/consent` route now uses a lock-free preflight to
capture the current grant generation (`consent_version` + exact PostgreSQL
`granted_at` text). An active grant is withdrawn only after the matching
deterministic operation receives a durable Ledger ACK. No account, consent,
submission, or token lock is held during the network request.

After ACK, the apply transaction reacquires the same user safety/account locks
used by grant and upload flows, locks the current consent row, and verifies the
exact grant and withdrawal timestamps. It then atomically records the
withdrawal audit event, revokes outstanding upload tokens, transitions
submissions, and preserves/requeues durable media-purge jobs. A grant or other
lifecycle change during the Ledger round-trip returns
`identity_l3_consent_state_changed_retry`; the acknowledged operation remains
unapplied for reconciliation and cannot revoke a newer grant.

When consent was already withdrawn, the route still performs idempotent token
and media cleanup without emitting a duplicate Ledger event. The route has
structural regression coverage for ACK ordering, lifecycle revalidation, token
revocation, audit insertion, and purge handling. PostgreSQL-backed concurrent
route tests and the full CI/E2E runs remain outstanding.


### Migration ordering correction

The ACK-gated operations schema is installed by
`244_privacy_recovery_ack_gated_operations.sql`. The earlier draft filename
used sequence number 241, which already exists in the base branch for the L3
replay migration; it was replaced so the new migration follows existing
migrations 241–243 without a duplicate sequence number.


## Multi-resource voice-intro erasure

A batch coordinator, `runAckGatedPrivacyRecoveryBatch`, now supports operations
that must all be acknowledged before any domain mutation is allowed. It
persists every immutable intent, obtains and durably stores every individual
Ledger ACK, then locks all operation rows in stable UUID order. Only when every
operation is acknowledged does it execute the domain callback and mark every
operation applied in the same PostgreSQL transaction. A partial Ledger outage
therefore leaves acknowledged/pending intents resumable and does not partially
erase the resource set.

The `DELETE /api/profiles/me/voice-intro` route uses this batch for the clip
erasure event and, when a current consent grant exists, its separate withdrawal
event. The apply transaction revalidates the exact clip ID/path/creation time
and consent version/grant/withdrawal timestamps after all ACKs. It then records
the consent withdrawal event, queues encrypted-file purging, and deletes the
clip row atomically. Re-consent, clip replacement, or another lifecycle change
during the ACK round-trip returns `voice_intro_state_changed_retry` rather than
erasing a newer resource.

The batch coordinator has unit coverage for a partial Ledger outage, retry
from already-persisted ACKs, all-or-nothing domain apply, and completed-batch
idempotency. The voice route has structural regression coverage. PostgreSQL
route-level concurrency tests and full CI/E2E validation remain outstanding.


## Profile photo erasure migration

The profile update route now captures the exact removed photo asset set before
contacting the Ledger, without holding PostgreSQL row locks. Each removed asset
gets a deterministic operation ID scoped to the owner, asset ID and immutable
upload creation timestamp. The batch coordinator obtains and persists all
Ledger ACKs before running the profile update.

The apply transaction reacquires the gift/account safety lock, revalidates the
retained photo ownership and compares every removed asset's ID, storage path and
exact creation timestamp against the preflight snapshot. A concurrent replacement
or asset-set change aborts the transaction with a retryable conflict. Profile
mutation, photo metadata deletion and durable physical-purge queue insertion
commit together with all batch operations marked applied. The route no longer
uses the legacy privacy outbox.

## Account erasure migration

Paddle checkout and subscription cancellation/reconciliation remain outside
the privacy Ledger apply callback. Once provider-side reconciliation is complete,
the route releases both session-level checkout and account-safety advisory locks
before requesting the Ledger ACK. The deterministic operation ID is scoped to
the account UUID and immutable account creation timestamp.

The apply callback reacquires transaction-scoped checkout, account-safety and
account-reuse locks, then revalidates the active account identity, account
generation, current billing/checkout state and L3 private-media purge
prerequisites. It atomically queues private photo and voice-intro purges,
suspends gift orders and revokes gift-address references, tombstones/anonymizes
the account, removes permitted consent and engagement records, and records the
90-day account-reuse restriction. The operation is marked applied in the same
transaction. A Ledger outage prevents the destructive callback while the account remains fail-closed in the pending state, available for retry with the same operation identity. A stale account
or billing snapshot returns a retryable conflict. No PostgreSQL advisory lock
is held while waiting for the remote Ledger.
