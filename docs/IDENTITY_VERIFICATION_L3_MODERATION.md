# Vow L3 manual verification: implementation and security design

Status: implementation exists in this PR behind the server-side `IDENTITY_L3_ENABLED` flag; this is not a production-readiness claim. The repository now contains explicit versioned consent and withdrawal, single-use upload capabilities, streaming AES-256-GCM private-volume storage, asynchronous media scanning, authenticated moderator review and decisions, append-only audit events, retryable physical purge, orphan cleanup, and six-month approval expiry. PostgreSQL integration tests exercise upload, moderator review, decision, and rejected-media purge. Keep the flag disabled in production until the deployment has a durable private volume, managed secret/key rotation and backup controls, ClamAV/probe health, a running purge worker and expiry worker, monitored deletion failures, and a completed operational/security review. L2 alone and all client-supplied L3 fields remain insufficient for L3 access.

## Required access model

Keep the levels independent and server-derived:

- L0: account contact verification; no identity assurance.
- L1: liveness/selfie check; no government-ID assurance.
- L2: Didit Live approval with non-empty approved ID-verification, liveness, and face-match evidence. Sandbox remains pending.
- L3: separate Vow manual review of a 30–60 second statement video, approved by an authorized moderator and not expired/revoked.

For male accounts, the interaction policy must be the conjunction of valid L2 and active L3. Neither level may overwrite or imply the other. Women remain outside this male-specific gate. The policy must be enforced in every server route that creates likes, messages, passes, discovery visibility, or other restricted actions; client state is display-only. Missing, stale, revoked, pending, or malformed evidence fails closed.

## Video storage boundary

Do not store video bytes in PostgreSQL, application logs, public web roots, profile-photo storage, or a container layer. Do not reuse the profile-photo sanitizer: video needs a separate parser/scanner pipeline.

Production storage must be a dedicated private object-storage bucket or private mounted volume with:
- encryption at rest using a managed key; TLS in transit;
- random server-generated object keys, never user filenames or public URLs;
- no public ACL, directory listing, CDN caching, or direct browser-readable permanent URL;
- short-lived, single-object upload authorization bound to the authenticated user, submission ID, maximum size, and expiry;
- strict allowlist of MP4/WebM and validated container/codec/duration; 30–60 seconds only, bounded bytes and resolution, reject malformed or oversized media;
- malware/media parser isolation and asynchronous processing before moderation;
- checksum, byte count, detected MIME/codec, duration, storage key, and processing state recorded as metadata only;
- private moderator playback via short-lived, audited, read-only access; never return storage keys to clients;
- retention/deletion jobs and verified object deletion on account deletion, withdrawal before review, rejection expiry, and policy-defined retention expiry;
- backups, replicas, lifecycle rules, and deletion verification included in the retention policy.

Do not enable upload endpoints until the deployment has a real private storage backend, encryption configuration, lifecycle/deletion controls, and an operational health check. A local development volume is not proof of production-grade storage.

## Submission lifecycle

Use explicit states, not a client-writable `approved` flag:

`draft -> upload_authorized -> uploaded -> processing -> pending_review -> approved | rejected`

Exceptional transitions:
- user withdrawal before a moderator decision: `withdrawn`;
- invalid media or failed scan: `rejected` or `needs_resubmission` with a safe reason code;
- approval expiry after six months: `expired`;
- safety/admin action: `revoked`.

A resubmission creates a new immutable submission/version and never mutates the prior decision. Only one current submission may be pending per user. Repeated requests must be idempotent. Upload authorization must be single-use and expire quickly. A client callback or upload-complete claim never advances directly to `pending_review`; the server verifies object existence, checksum, size, media metadata, and scan result.

## Moderator queue and decision controls

- Queue queries expose only the minimum account and submission metadata needed to review.
- Only active `admin` or `moderator` accounts may access the queue; enforce this in the API and transaction, not only the UI.
- Require a reason code for every decision. Do not expose internal notes or raw media URLs to the applicant.
- Prevent self-review and concurrent duplicate decisions. Lock the submission row and verify it is still pending before recording a decision.
- Approval is valid only when the referenced submission is fully processed and all checks passed.
- Rejection and revocation must not erase earlier decisions. A new submission is required for another attempt.
- Audit every view, playback authorization, decision, revocation, and administrative override. Do not put video, biometric data, identity documents, or secrets in audit metadata.

## Immutable decision history

Use append-only decision events with:
- submission ID, user ID, moderator ID, action, reason code, policy version, decision timestamp, and prior/current state;
- database constraints and triggers rejecting UPDATE/DELETE for ordinary application roles;
- a transaction that appends the event and updates the current projection atomically;
- unique/idempotency protection against replayed moderator actions;
- separate privileged retention/purge procedure for legally required deletion, with its own audit event.

An application-level promise not to edit rows is insufficient. Database permissions and constraints must enforce append-only behavior.

## Six-month expiry, revocation, and re-verification

Approval expires at `approved_at + interval '6 months'`. Every authorization check must compare the expiry against database time; a scheduled worker is only cleanup/notification, never the security boundary. Expiry immediately removes L3 eligibility. Re-verification creates a new submission and decision chain. Revocation takes effect transactionally and immediately blocks restricted actions. Account deletion must remove the video object and user-linked media metadata according to the published retention policy while preserving only legally permitted, minimized audit evidence.

## Required regression coverage

1. Male L2-only, L3-pending, L3-rejected, L3-expired, L3-revoked, missing-L3, and malformed-L3 states are denied for every restricted action.
2. Male with current L2 + approved unexpired L3 is allowed; expired L2 or expired L3 is denied.
3. Women are not accidentally blocked by the male-specific policy.
4. A client cannot submit or change moderator ID, decision, approval timestamp, expiry, or L3 status.
5. A non-moderator, inactive moderator, and self-review attempt are denied.
6. Two concurrent moderator decisions yield exactly one committed decision.
7. Duplicate uploads, replayed upload-complete calls, stale upload tokens, wrong-user object keys, oversized files, invalid MIME/container, and failed scans fail closed.
8. Revocation and expiry block access immediately even if the scheduled worker is delayed.
9. Account deletion and retention jobs remove the actual object, not only its database row.
10. All L2/L3 policy tests exercise the shared server policy used by every route; no route-specific weaker SQL predicate remains.

## Rollout order

1. Add schema and append-only database protections.
2. Add private storage adapter and deployment configuration; keep feature disabled until storage checks pass.
3. Add upload authorization, upload completion verification, scan pipeline, applicant status endpoint, and moderator queue.
4. Add transactional moderator decisions, revocation, expiry worker, retention/deletion handling, and audit.
5. Replace duplicated route checks with one shared L2+L3 policy and apply it to every restricted server action.
6. Add PostgreSQL integration tests, concurrency tests, API tests, and Browser E2E for applicant and moderator flows.
7. Enable behind a server-side feature flag only after CI, Browser E2E, deployment storage checks, and security review all pass.

## Current repository boundary

The current deployment has a private `private_photos` volume for profile photos, and Didit L2 stores provider session/status metadata only. Neither is an L3 video storage or manual-review system. Do not point L3 video at `PHOTO_STORAGE_DIR`, and do not infer L3 from the Didit `verified` status. The L3 feature remains operationally unavailable until the storage and moderation workflow above exists.


## Interim enforcement state (2026-11-01)

The shared `canInteract` policy now requires all of the following for male accounts: Didit L2 status `verified` in the `live` environment, L3 status `approved`, and an L3 expiry timestamp later than the current time. Missing or malformed L3 fields deny access. All five existing restricted interaction routes return `requiredLevel: L2_AND_L3`. Women remain outside this male-specific gate.

Important operational consequence: trusted L3 decisions are now stored and read from PostgreSQL, but there is no production submission, private-media processing, or moderator workflow capable of creating a legitimate approval. Existing male accounts are therefore intentionally denied restricted actions until the complete L3 workflow is implemented and deployed. This is a deliberate fail-closed release hold, not a claim that L3 is operational. Do not bypass it by setting client fields or by treating Didit L2 as L3.


## PostgreSQL foundation added (migration 114)

Migration `114_identity_l3_workflow.sql` adds metadata-only submission records, a one-open-submission-per-user constraint, moderation/expiry indexes, and append-only decision-event storage. Database guards restrict lifecycle transitions, prevent submission identity changes, prohibit self-review, and make the moderator decision fields immutable after a decision. Approval expiry is constrained to exactly six calendar months after approval. The integration schema test is included in `npm test`.

This is a database foundation, not an operational L3 feature. Trusted decision lookup, transactional audit recording, male interaction authorization, profile visibility checks, and safe trust-summary projection are now wired to PostgreSQL. However, there is still no upload authorization endpoint, configured production video volume/key management, malware/transcode/metadata scanning worker, moderator UI/API, or retention/deletion worker. A standalone AES-256-GCM streaming storage primitive now exists in `server/identityL3Storage.js`; it is not yet wired to the API or Compose, and does not by itself constitute a deployable media store. No production workflow can create a legitimate L3 approval, so male restricted actions remain fail-closed in normal operation. Do not manually populate approval fields or treat this migration as a completed verification workflow.


## Latest schema hardening (2026-11-01)

Migration 114 additionally requires a bounded reason code for every approval, rejection, and revocation. Once a video upload has been accepted, its checksum, MIME type, byte count, duration, upload timestamp, processing timestamp, and object identity cannot be replaced by a later update. The only allowed object-key mutation is a one-way purge operation that clears the key and records `media_purged_at` atomically. PostgreSQL integration coverage exercises attempted media replacement and the permitted purge transition, and verifies the decision-reason constraint.


## Trusted L3 lookup wired into restricted actions (2026-11-01)

All five restricted interaction handlers now read the current approved, unexpired L3 submission from PostgreSQL rather than relying on request fields or a hard-coded missing value. The lookup is performed inside the action transaction and takes a row-level `FOR SHARE` lock on the selected approval so a concurrent revocation/expiry transition cannot race past an in-flight restricted action; the revocation/expiry update waits for that action transaction to finish, and subsequent actions see the new state. Integration coverage creates a synthetic approved L3 row for the positive path and verifies that a second account with live L2 but no L3 remains denied for like, pass, and discovery undo. This does not enable L3 in production: the secure upload, scanning, moderator workflow and retention components are still absent.

The migration also requires a completed processing timestamp before a submission can enter `pending_review`, `approved`, or `rejected`. Media purge is permitted only as a one-way operation in a terminal/decided state, and processing completion may be recorded exactly once when the workflow advances from `uploaded` to `processing`.

The same active L3 requirement now applies to male profile discovery, public profile-photo reads, match lists, and conversation access. This prevents an L2-only male account from appearing to women or remaining reachable through direct API URLs after L3 expiry/revocation. Public lookup predicates take a shared lock on the qualifying L3 row while the read/operation transaction is active.

Account deletion now removes L3 submission metadata and its dependent decision events in the same transaction when no media object key remains. If an L3 object key exists while the private-media deletion worker is unavailable, deletion returns `409 identity_l3_media_purge_unavailable` instead of deleting the database reference and orphaning private video. This is a temporary fail-closed safeguard until the encrypted storage adapter and deletion worker are deployed.

Decision events reject direct updates and deletes. The database trigger permits deletion only when PostgreSQL invokes it as a nested foreign-key cascade from deletion of the parent submission; this is required for account/privacy deletion and does not permit direct audit tampering. Integration coverage verifies both direct-delete rejection and parent-cascade cleanup.

The database now exposes one canonical current-decision lookup (`identity_l3_current_decision`) and one fail-closed predicate (`identity_l3_has_active_approval`). The lookup locks the newest terminal trust decision (`approved`, `rejected`, `revoked`, or `expired`) and orders by approval recency first, then the revocation timestamp for that approval. Revoking an older superseded submission cannot invalidate a newer approval, while revoking the latest approval cannot fall back to an older one. A later revocation therefore supersedes any older still-unexpired approval; the system cannot accidentally fall back to stale approval history. All restricted actor checks and male-profile visibility predicates use these shared database functions.

The account-deletion preflight checks for stored L3 object keys before making any external Paddle cancellation call, then repeats the check inside the destructive database transaction. Any future upload/processing route must acquire the same per-account safety advisory lock so a new media object cannot race between those checks and deletion.

A newer rejected re-verification also supersedes an older approval. Withdrawn or still-pending attempts do not erase a still-valid approval; a later approval can restore access, while a later rejection or revocation fails closed.

The event actor UUID is retained as an immutable audit identifier without a foreign key that would attempt to `SET NULL` on moderator account deletion (which would conflict with append-only enforcement). The submission owner remains linked for account-level privacy cascade cleanup.

An `AFTER INSERT OR UPDATE` database trigger now records creation, upload, processing, review, decision, revocation, expiry, withdrawal, and media-purge events in the same transaction as each submission change. Approval/rejection events identify the independent reviewer; other actions can supply a transaction-local `app.identity_l3_actor_user_id` and `app.identity_l3_reason_code`. This removes the possibility that an application handler commits a state change but forgets its audit event.

Submission decision reasons and audit-event reasons are constrained to short lowercase machine-readable codes (`[a-z0-9_]`, at most 64 characters); free-form moderator notes and personal data do not belong in this audit channel.

Applicant-owned events may identify the applicant as actor; only approval/rejection events enforce actor != submission owner. Independent review remains enforced both on the submission row and the corresponding audit event.

The authenticated trust-summary API now exposes only safe L3 state: latest submission status, latest terminal decision status, and approval expiry when present. It never returns storage keys, file metadata, video bytes, moderator notes, or biometric/document data. Pending/withdrawn submissions are visible as workflow status without displacing a still-valid prior approval in the authorization decision.

The workflow includes an explicit terminal `failed` state for upload/processing failures, with a `processing_failed` audit event. Failed media can be purged through the same one-way terminal-state operation; the production PostgreSQL integration test exercises a real rejected-submission purge and confirms its audit event.


## Encrypted L3 storage primitive (2026-11-01)

The repository now contains a standalone streaming storage adapter in `server/identityL3Storage.js`. It uses AES-256-GCM with a fresh 96-bit nonce per object, a 128-bit authentication tag, server-generated UUID object keys, SHA-256 over plaintext, a hard maximum of 100 MiB, exclusive temporary-file creation with restrictive permissions, atomic publication, and authenticated decryption. Moderator reads are decrypted incrementally into a mode-0600 staging file under `IDENTITY_L3_TEMP_DIR`, never beside encrypted objects. Compose mounts this path as a bounded, container-private tmpfs owned by the unprivileged `node` user; the encrypted-media volume remains read-only in the processing worker. The read stream is returned only after AES-GCM verifies the complete ciphertext, so unauthenticated plaintext is never exposed and the full video is not buffered in Node.js memory. The staging file is removed when the consumer closes the stream or when authentication fails. API and processing-worker startup remove abandoned staging files from an earlier process before accepting work, and each process limits concurrent decryptions to two. Object-key validation prevents caller-controlled path traversal. Failed writes remove the temporary object. Unit tests cover round-trip encryption, wrong-key rejection, ciphertext tampering, removal of staged plaintext after authentication failure, upload-size enforcement, temporary-file cleanup, and invalid object keys; the test is part of `npm test`.

This is a cryptographic storage primitive only. It is not yet connected to authenticated upload authorization, PostgreSQL submission transitions, private-volume deployment, moderator playback, media parsing/antivirus scanning, or deletion/retention workers. No upload endpoint must be enabled until those controls and their integration tests exist. The encryption key must be supplied as a server-only 32-byte hexadecimal secret by the deployment secret manager; it must never be committed, exposed to the browser, logged, or reused as a photo-storage key. `IDENTITY_L3_TEMP_DIR` must point to a private, size-bounded ephemeral filesystem with mode `0700`; do not place decrypted staging files on the persistent encrypted-media volume or include the scratch filesystem in backups.


## Single-use upload authorization foundation (2026-11-01)

Migration `115_identity_l3_upload_tokens.sql` adds short-lived, one-time upload capabilities. PostgreSQL stores only the SHA-256 digest, binds each capability to both the submission and its owner, limits expiry to 15 minutes, prevents more than one unconsumed capability per submission, and enforces immutable token identity plus one-way consume/revoke timestamps. The application helper currently issues 32-byte cryptographically random URL-safe tokens with a 10-minute lifetime, requires an active male account with Didit Live L2 verified from database state, takes the same per-account advisory lock used by account-deletion/gift safety workflows, and consumes a capability atomically for the authenticated owner. Re-authorization revokes an earlier unused capability before issuing a replacement.

This is still an authorization foundation, not an enabled upload API. The helper must be called inside a caller-owned PostgreSQL transaction. During upload, the caller must retain the transaction and its account advisory lock until the encrypted object key is persisted on the submission; on failure it must commit the consumed token without an object key. This prevents account deletion from racing an in-flight write and orphaning a private object. The HTTP streaming endpoint, pre-body token consumption, bounded streaming upload, MIME/container validation, encrypted private-volume configuration, worker scanning, moderator playback/decision API, and physical retention/deletion are not yet integrated. Do not expose an upload route or mark a submission uploaded until the encrypted object is durably stored and independently validated. A failed or interrupted upload burns its single-use capability and requires a newly issued one.


## Six-month approval expiry worker (2026-11-02)

A bounded expiry worker is now deployed as a backend-only Compose service. It scans approved submissions whose `expires_at` is at or before PostgreSQL `NOW()`, then processes each account under the same per-account advisory safety lock used by account deletion and identity-gated actions. It updates expired approvals to the terminal `expired` state inside a transaction. The existing database trigger records the state transition as an append-only `expired` event with reason code `approval_expired`.

The worker is cleanup and audit-state maintenance only. Authorization continues to check `expires_at > NOW()` synchronously in `identity_l3_has_active_approval`; a delayed or unavailable worker cannot extend access. Candidate discovery is bounded and rotated, account failures are isolated, and the worker retries on the next minute. The Compose service runs only on the internal backend network and starts after migrations complete.

This does not complete the L3 workflow. Authenticated video upload, private volume/key configuration, media parsing and malware scanning, moderator queue/playback/decision/revocation endpoints and UI, and policy-defined media retention/deletion remain release blockers.


## Integrated L3 workflow and current release boundary (2026-11-02)

The current branch now contains an integrated, feature-flagged L3 workflow rather than only the earlier schema/storage foundations:

- Applicants grant versioned consent, receive a short-lived single-use upload capability, and upload bounded MP4/WebM bytes over the authenticated API. The capability is consumed in the same account-locked transaction that stores the encrypted object reference.
- The API writes AES-256-GCM encrypted objects to the private `private_identity_l3` volume. Object keys are server-generated UUIDs; the database stores only metadata and opaque keys.
- The processing worker reads the encrypted volume read-only, authenticates/decrypts the object, scans it with ClamAV, and validates the actual container, codecs and 30–60 second duration with ffprobe before moving the submission to moderator review.
- The moderator console provides audited private playback and independent approve/reject decisions. Current consent and pending-review state are checked again at playback and decision time.
- Consent withdrawal revokes unused upload capabilities, immediately invalidates L3 access, and queues durable media deletion. Failed purge jobs can be retried. Six-month expiry is enforced synchronously by the authorization predicate and maintained by a bounded expiry worker.
- Account deletion is serialized with uploads, processing, moderator reads and purge work. It refuses to remove the account while an L3 object key remains, rather than orphaning the encrypted video.
- PostgreSQL triggers preserve lifecycle invariants and append-only decision/access events. The relevant integration suites are included in the repository test command.

### Plaintext staging boundary

Both authenticated decryption staging and the separate ClamAV/ffprobe working copy use `IDENTITY_L3_TEMP_DIR`. Compose mounts that directory as a 256 MiB container-private tmpfs owned by the unprivileged `node` user. The processing worker retains a read-only mount of the encrypted volume; the API and worker never need to make that volume writable to decrypt media. Each process allows at most two concurrent authenticated decryptions. Startup removes abandoned `.decrypt-*` files and `vow-l3-check-*` processing directories left by an earlier process. Do not back up or persist this tmpfs.

### Production remains gated

`IDENTITY_L3_ENABLED` remains `false` by default. Passing CI does not satisfy the following deployment requirements:

1. Inject the encryption key through a production secret manager, not a committed file or browser-visible configuration. Define a versioned keyring and a tested rotation/re-encryption procedure before storing real applicant videos; the current single-key object format does not provide transparent rotation.
2. Use a persistent private volume with restricted host access, encrypted infrastructure/backups, tested restore procedures, retention limits and deletion propagation to snapshots/replicas/backups.
3. Configure monitoring and alerting for processing, expiry and purge workers, ClamAV health/signature freshness, queue age, repeated failures, tmpfs exhaustion and storage capacity.
4. Run a production-like deployment test covering upload, scan, moderator playback, approval, consent withdrawal, physical deletion, account deletion, worker restart and restore/recovery.
5. Complete a privacy/security review of the published consent, retention schedule, access roles, incident response and moderator audit process.

Until those gates are signed off, L3 stays disabled in production. The integrated code and passing automated tests are not a substitute for those operational controls.
