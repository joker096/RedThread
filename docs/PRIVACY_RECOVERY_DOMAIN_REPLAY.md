# Privacy recovery domain replay: workflow gates

This document records the domain-level constraints and current disposition of the isolated restore replay executor. The executor is restricted to a newly restored, non-production database with services, workers, webhooks and egress disabled. It does not run against the live application database and never unlinks media files.

## Event-to-workflow matrix

| Ledger event | Required domain workflow | Current replay disposition |
| --- | --- | --- |
| `account_erasure_requested` | Full account deletion orchestration, including Paddle reconciliation/cancellation, session revocation, gift suspension/payment reconciliation, profile anonymization, consent-history purge, and durable media purge queues | **Manual reconciliation required.** Do not translate this event into a direct `users.status` update. The live HTTP workflow can make an external Paddle call and has safety-lock and checkout-state prerequisites. |
| `voice_intro_consent_withdrawn` | Lock account; append withdrawal history; revoke access by withdrawing consent; queue every owned voice clip for purge; delete clip metadata | **Implemented in the isolated executor.** Each event commits atomically with its receipt; exact retries are idempotent. |
| `voice_intro_erasure_requested` | Resolve the exact clip; queue its validated private storage path; delete that clip's metadata | **Implemented in the isolated executor.** Requires a unique subject/resource mapping and the existing voice-intro path guard. |
| `private_photo_erasure_requested` | Resolve exact photo; queue its private storage path; remove the profile URL and photo metadata | **Implemented in the isolated executor.** Requires exact ownership and the existing private-photo path guard. Queue worker deletion remains separate. |
| `identity_l3_consent_withdrawn` | Lock account; withdraw consent and append immutable history; revoke unused upload tokens; transition all eligible submissions to terminal withdrawn/revoked states; let the database trigger create purge jobs | **Implemented in the isolated executor.** It enumerates all eligible submissions and relies on the database transition trigger for purge-job creation; it never inserts directly into that queue. |
| `ad_consent_revoked` | Apply the master opt-out to all purposes/categories; append a new consent-history snapshot; ensure ad eligibility reads the revoked state | Eligible only as a full opt-out. The external event has no category/resource detail, so replay must not infer a narrower set of revoked categories. |
| `gift_order_consent_withdrawn` | Resolve exact order; check both accounts and locks; re-evaluate status/payment/dispatched eligibility; cancel only eligible orders; clear address-vault reference; append order event; run payment reconciliation if required | **Blocked unless the current order state passes the existing withdrawal policy.** Never cancel dispatched, paid/reconciling, or otherwise ineligible orders by replay assumption. |
| `gift_address_draft_consent_withdrawn` | Resolve the exact temporary address draft by order ID and recipient; confirm the same consent grant lifecycle; delete the live ciphertext row and append the local withdrawal event | **Implemented in the isolated executor, with receipt/effect schema support added by migration 252.** It deletes only the temporary draft and appends withdrawal history; it does not cancel the order or touch the verified-address Vault. |

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

## Implemented isolated replay executor

The current executor supports exactly these five event types:
- `private_photo_erasure_requested`
- `voice_intro_erasure_requested`
- `voice_intro_consent_withdrawn`
- `identity_l3_consent_withdrawn`
- `gift_address_draft_consent_withdrawn`

Photo, voice and L3 events create database-backed purge obligations only. The executor never unlinks media; existing purge workers remain the only file-deletion authority. Gift-address-draft withdrawal has no media purge obligation and never mutates the gift order or verified-address Vault.

### Durable idempotency receipt

The append-only `privacy_recovery_replay_receipts` table is already implemented. Each receipt binds:
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
8. Insert the receipt, effect and any purge obligations in the same transaction as that event's domain operations. Each event is individually atomic. If a later event fails, earlier committed events remain safely resumable through their immutable receipts; the coordinator stops at the first failure.
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

The executor remains restricted to isolated, non-production restores. Account erasure, advertising preference replay and gift-order cancellation remain unsupported and require their own domain-specific reconciliation workflows. The role boundary between the read-only restore verifier and the least-privilege replay writer, host-level writer isolation, full PostgreSQL integration coverage, and exact-HEAD CI/browser/mobile/virtual-device checks remain release blockers.


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


## Post-replay verification evidence

Migration 237 adds immutable replay-effect records and SHA-256-only purge obligations. The media executor writes them in the same transaction as the domain mutation and replay receipt; raw storage paths remain only in the existing purge queues.

`server/privacyRecoveryMediaVerification.js` performs a read-only repeatable-read audit in an explicitly isolated, non-production restore. It checks contiguous event coverage, canonical event digests and receipt outcomes, effect records, absence of deleted photo/voice metadata, photo URL removal, withdrawn voice consent, and that every recorded purge obligation still exists in its corresponding queue. The report contains counts and watermarks only, never user IDs, resource IDs or storage paths.

The verifier intentionally fails if a photo/voice erasure lacks a recorded purge obligation or if a queued path has disappeared before verification. Therefore purge workers must remain disabled until the report is complete and reviewed. This is a verification tool only; it does not delete files, start workers, or activate external services.

## Restore activation gate

`scripts/restore-private-media.sh` now leaves a private `.vow-restore-pending` marker in every successfully extracted staging directory. A restored directory is not an application media volume merely because archive extraction succeeded.

The only supported activation path is `scripts/activate-private-media-restore.sh`. It requires the exact staging directory and an existing empty mountpoint, the pending marker and absence of a ready marker, and an absolute executable non-symlink `PRIVACY_RECOVERY_GATE_EXECUTABLE` supplied by the isolated recovery environment.

The gate executable must complete the full restore-specific domain reconciliation: source archive and ledger verification, contiguous inventory, supported privacy-event replay, immutable receipt/effect verification, purge-queue obligation verification, and explicit resolution of account-erasure, L3, advertising-consent, and gift/payment events. Unsupported or unresolved events must return non-zero. The activation script does not invent or infer domain decisions.

Only after the gate exits successfully does the script replace the pending marker with `.vow-privacy-reconciled` and perform the bind mount. A failed gate never mounts; a failed bind mount restores the pending state. The tests use temporary directories and stubbed mount commands; they do not mount or modify host volumes.

Do not mount restored media through Docker, systemd, or another mechanism that bypasses this gate. Production deployment remains disabled until the isolated recovery gate executable is implemented, reviewed, and wired to the actual restored database and ledger. The current helper provides fail-closed activation mechanics; it does not itself implement Paddle/gift/L3 domain replay.

## Explicit restored-database identity guard

Every inventory, coordinator, media executor, and post-replay verification connection now checks the actual PostgreSQL identity before reading or changing recovery state. Recovery requires all of the following operator-supplied environment values:

- `PRIVACY_RECOVERY_RESTORE_ISOLATED=true`
- `PRIVACY_RECOVERY_RESTORE_DATABASE_NAME=vow_restore_<unique_name>`
- `PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE=vow_restore_<dedicated_role>`
- `PRIVACY_RECOVERY_RESTORE_CONFIRMATION=ISOLATED_RESTORE_ONLY`
- `NODE_ENV` must not be `production`

The process executes `SELECT current_database(), current_user` on the same PostgreSQL connection used by the recovery transaction and compares both values exactly. A mismatch aborts before inventory, replay, or verification proceeds. The restore database and role must be created specifically for the isolated recovery exercise; do not reuse the application database role. This guard is an additional fail-closed check, not a substitute for network isolation, disabled workers/webhooks/egress, or operator verification that the target infrastructure is disposable.


## Purge completion is distinct from a queued obligation

The immutable `privacy_recovery_replay_purge_obligations` rows describe what must be deleted. They are not proof that deletion finished. The operational photo and voice purge queues are transient: workers remove queue rows after a successful unlink (or after confirming the file is already absent). Therefore queue presence must never be treated as successful completion.

Migration 239 adds append-only `privacy_recovery_replay_purge_completions`, keyed to the immutable obligation and containing only the ledger sequence, queue type, path digest, and completion timestamp. Each purge worker now writes the completion receipt in the same database transaction in which it removes the operational queue row, and only after the filesystem unlink succeeded or returned `ENOENT`. If the worker crashes after unlink but before commit, the queue task remains and the retry safely treats `ENOENT` as success before recording completion.

The restore verifier requires:
- every immutable obligation has exactly one completion receipt;
- the matching operational queue item is no longer present;
- the receipt/effect/metadata/visibility checks still pass.

A missing completion or a still-queued obligation blocks activation. The completion table is append-only and stores no raw filesystem paths. This proves the purge worker's successful unlink outcome; it does not replace host-level storage inspection or infrastructure isolation.
