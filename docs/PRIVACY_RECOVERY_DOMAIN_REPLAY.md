# Privacy recovery domain replay: workflow gates

This document records the domain-level constraints that a future replay executor must preserve. The current inventory remains read-only. No function in this stage changes consent, account status, gift orders, database rows, or media.

## Event-to-workflow matrix

| Ledger event | Required domain workflow | Current replay disposition |
| --- | --- | --- |
| `account_erasure_requested` | Full account deletion orchestration, including Paddle reconciliation/cancellation, session revocation, gift suspension/payment reconciliation, profile anonymization, consent-history purge, and durable media purge queues | **Manual reconciliation required.** Do not translate this event into a direct `users.status` update. The live HTTP workflow can make an external Paddle call and has safety-lock and checkout-state prerequisites. |
| `voice_intro_consent_withdrawn` | Lock account; append withdrawal history; revoke access by withdrawing consent; queue every owned voice clip for purge; delete clip metadata | Eligible only after all clips for the mapped user are enumerated and queue insertion can be verified in the same transaction. |
| `voice_intro_erasure_requested` | Resolve the exact clip; queue its validated private storage path; delete that clip's metadata | Eligible only when the exact clip belongs to the mapped subject and the path is validated by the existing voice-intro storage policy. |
| `private_photo_erasure_requested` | Resolve exact photo; queue its private storage path; remove the profile URL and photo metadata | Eligible only when exact ownership is verified and the path passes the existing private-photo path guard. Queue worker deletion is a separate operation. |
| `identity_l3_consent_withdrawn` | Lock account; withdraw consent and append immutable history; revoke unused upload tokens; transition all eligible submissions to terminal withdrawn/revoked states; let the database trigger create purge jobs | Eligible only after enumerating every L3 submission for the user. A subject-level event does not identify one submission. Never insert directly into the L3 purge queue: its guarded trigger is the enqueue authority. |
| `ad_consent_revoked` | Apply the master opt-out to all purposes/categories; append a new consent-history snapshot; ensure ad eligibility reads the revoked state | Eligible only as a full opt-out. The external event has no category/resource detail, so replay must not infer a narrower set of revoked categories. |
| `gift_order_consent_withdrawn` | Resolve exact order; check both accounts and locks; re-evaluate status/payment/dispatched eligibility; cancel only eligible orders; clear address-vault reference; append order event; run payment reconciliation if required | **Blocked unless the current order state passes the existing withdrawal policy.** Never cancel dispatched, paid/reconciling, or otherwise ineligible orders by replay assumption. |

## Findings from existing workflows

- Account deletion is a multi-step authenticated operation, not a tombstone update. It reconciles in-flight Paddle checkout and subscription state before the local deletion transaction. It also suspends gift orders, queues photo and voice files, revokes sessions, redacts messages, closes matches, removes consent records and creates the email-reuse restriction. A restore executor must not attempt to call the HTTP route as a substitute for a restore-specific domain service.
- Voice-intro deletion uses the account safety lock, queues private storage paths, and deletes metadata in a transaction. The worker requires the mounted private volume and safely retries missing files.
- Photo deletion must preserve the durable queue. The worker rejects paths outside the configured root or filenames that do not match the expected UUID-based format.
- L3 withdrawal revokes unused upload tokens and transitions all eligible submissions. The database trigger creates purge jobs for terminal submissions with retained encrypted media. The worker's leases and retry policy must remain authoritative.
- Ad consent is a versioned preference snapshot with append-only history. A master opt-out clears date offers, wedding offers, marriage-planning opt-in, and all category consents.
- Gift withdrawal is conditional. The live workflow verifies both active accounts, takes user/pair locks, rechecks the order under row lock, calls the eligibility policy, nulls the address-vault reference, and records an order event. Payment state is intentionally not simulated by the endpoint; reconciliation safeguards must be retained.

## Replay release gates

A future executor must refuse the entire batch unless all of the following are true:

1. The source export signature/checksum, sequence range, event IDs, schema versions, timestamps, and snapshot watermark have been verified.
2. The target database is a newly restored, isolated, non-production environment, with no public ingress, background workers, payment webhooks, or outbound notifications enabled.
3. Every event has exactly one subject mapping; every resource-bearing event has exactly one type-correct resource mapping. No partial replay is allowed.
4. The executor uses existing domain policy functions and transaction/lock order. It does not reproduce policy from loosely copied SQL.
5. Account erasure and gift withdrawal have explicit external-provider reconciliation decisions. Unknown Paddle state or unknown gift payment state blocks replay.
6. Purge queues are verified after domain transitions, but file deletion is a separately approved step with mounted-volume identity and backup-retention checks.
7. A second read-only inventory confirms the expected consent state, tombstones, order state, queue obligations, and absence of unresolved mappings.
8. The final report is metadata-only. It must not contain raw identifiers, addresses, media paths, or event payloads.

No account erasure or gift-order cancellation is currently replayable solely from the privacy ledger event. The ledger records a privacy intent, not all business/payment facts needed to safely repeat the original operation.

## Transactional executor design: private photo and voice events

The first executable domain-replay slice is limited to:
- `private_photo_erasure_requested`
- `voice_intro_erasure_requested`
- `voice_intro_consent_withdrawn`

It must enqueue database-backed deletion obligations only. It must never unlink media during event replay. The existing purge workers remain the only file-deletion authority and are not started by replay.

### Durable idempotency receipt

Before implementing the executor, add an append-only `privacy_recovery_replay_receipts` table in a new migration. Each receipt must bind:
- the original `event_id` and `ledger_sequence`;
- a SHA-256 digest of the canonical staged event fields;
- the event type and a non-sensitive outcome code;
- the transaction timestamp.

Enforce uniqueness on both event ID and ledger sequence. Prevent UPDATE/DELETE with database triggers, matching the immutable staging-table policy. A repeated event with the same ID, sequence, and digest is a no-op; any collision with different content aborts the whole replay transaction. The receipt must be checked before attempting resource mapping, because a successful first pass removes the resource row and would otherwise make an identical retry appear unresolved.

### Batch transaction and lock protocol

1. Validate the verified archive watermark and complete contiguous sequence before opening a write transaction. Reject unsupported event types and any unresolved or ambiguous mapping for the selected batch.
2. Open one transaction against the isolated restored database. Acquire the same per-user safety locks used by live account/profile mutations, in deterministic sorted user-ID order. Do not invent a second advisory-lock namespace.
3. Check existing receipts. Exact matching receipts are skipped; conflicting receipts abort. Only unreceipted events proceed to domain checks.
4. Lock mapped photo/voice rows in deterministic sorted resource-ID order with `FOR UPDATE`. Recheck each row's owner against the mapped subject. Missing unreceipted resources are a hard conflict, not a successful no-op.
5. Validate every storage path with the exact live storage-path guard before queue insertion. For photos, reuse the private-photo worker's root/UUID/extension policy; for voice, reuse `resolvePrivateVoiceIntroPath`. Never normalize an unsafe path into an accepted path.
6. For photo erasure, remove the matching `/api/photos/<uuid>` entry from the owner's `profiles.photo_urls`, insert the exact storage path into `private_photo_purge_queue`, then delete the `photo_assets` row. All three operations must commit together.
7. For one voice-clip erasure, insert its exact storage path into `private_voice_intro_purge_queue`, then delete only the mapped `profile_voice_intros` row. For subject-level voice-consent withdrawal, lock the consent row and every owned clip, queue every clip, delete the clip rows, set `withdrawn_at`, and append the immutable withdrawal-history event in the same transaction. A missing consent row or unexpected already-withdrawn state without a matching receipt is a conflict requiring inventory review.
8. Insert receipts only after each event's domain operations have succeeded, but before commit. Any failure rolls back all queue changes, metadata changes, consent-history changes, and receipts in the batch.
9. After commit, run a fresh read-only inventory and compare expected queue obligations and consent state. File deletion remains a separately approved maintenance operation; no replay code invokes a worker or filesystem unlink.

### Required test matrix before enabling writes

- First execution creates exactly one queue obligation and one receipt per event.
- Replaying the identical batch creates no duplicate obligations and changes no timestamps/state.
- Same event ID with a different digest, or same sequence with a different event ID, aborts and rolls back the complete batch.
- Wrong owner, missing unreceipted asset, ambiguous mapping, malformed path, symlinked root, and invalid extension all abort without receipts or domain changes.
- Photo URL removal, metadata deletion, and queue insertion are atomic.
- Voice clip queue insertion and metadata deletion are atomic.
- Voice consent withdrawal queues every clip, revokes consent, and appends exactly one immutable history event atomically.
- Concurrent live profile deletion/upload and replay cannot bypass the existing user-safety lock protocol.
- A failed purge worker leaves its queue row retryable; replay never attempts direct file deletion.
- The test suite uses disposable PostgreSQL and temporary private-media roots only. No VPS, external ledger, Paddle, webhook, or production resource is involved.

The executor remains disabled until the receipt migration, lock integration, path-guard reuse, full PostgreSQL concurrency/rollback tests, and exact-HEAD six-check validation are complete. This design does not authorize account erasure, L3 replay, advertising preference replay, or gift/payment actions.


## Implemented first media-replay executor slice

`server/privacyRecoveryMediaExecutor.js` now exposes `applyPrivateMediaPrivacyRecoveryEvent`. It is deliberately a single-event transaction rather than a multi-event transaction: each event's domain mutation, purge-queue obligation and immutable receipt commit atomically. The recovery coordinator must invoke events in ascending ledger sequence and stop on the first conflict. Successfully committed earlier events remain safely resumable because their exact receipts make retries no-ops.

Supported event types are restricted to photo erasure, one voice-intro erasure, and voice-intro consent withdrawal. The executor:
- checks an existing receipt before requiring a still-present resource mapping;
- rechecks the receipt after acquiring the existing live per-user advisory lock, closing the concurrent retry race;
- verifies subject/resource pseudonyms against the supplied HMAC key;
- locks and rechecks ownership of the account and media row;
- validates the configured private storage root and exact media path before queuing;
- removes the photo URL, queues the file and deletes photo metadata in one transaction;
- queues/deletes one voice clip, or queues/deletes all clips and writes the same-transaction immutable consent withdrawal event;
- inserts the matching digest receipt before commit;
- rolls back all database changes on any validation or domain conflict.

The executor never deletes a file, starts a worker, calls an external service, or activates itself on server startup. It requires an explicit isolated recovery caller to provide a database pool, mapping, pseudonym key and the corresponding mounted private-media root. A coordinator, archive-watermark validation, post-replay inventory comparison, and real PostgreSQL concurrency/rollback integration tests are still required before the recovery workflow can be considered ready.


## Ordered isolated media coordinator

`server/privacyRecoveryMediaCoordinator.js` adds an explicit coordinator for a verified sequence range. It requires `NODE_ENV !== production`, `PRIVACY_RECOVERY_RESTORE_ISOLATED=true`, the pseudonym key, and caller-supplied snapshot and export watermarks. It reads the complete contiguous staged range in a repeatable-read, read-only transaction, resolves mappings against that snapshot, and then applies supported events in ascending ledger order.

The coordinator stops before the first unsupported event (including account erasure, L3, advertising, and gift events). It does not skip over a blocked event to apply later media events. Each supported event commits independently with its immutable receipt; a later failure leaves earlier events safely resumable. A subsequent run uses the same verified watermarks and exact receipts to continue.

This is still an isolated recovery utility, not a server route, scheduled job, or production startup hook. It does not provision or enable an isolated database, disable external egress/workers/webhooks, or guarantee the media volume is mounted read-only. Those are mandatory operator/environment controls. Post-replay inventory comparison and real PostgreSQL concurrency/rollback integration tests remain release gates.
