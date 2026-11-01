# Vow L3 manual verification: implementation and security design

Status: design baseline only. This document does not claim that L3 upload, moderation, or approval is implemented. Until the complete workflow is deployed and tested, no Didit L2 result or client-supplied field may be treated as L3.

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

Important operational consequence: the current database/API does not yet persist trusted L3 decisions, so existing male accounts are intentionally denied these restricted actions until the complete L3 submission, private media processing, moderator decision, revocation, and expiry workflow is implemented and deployed. This is a deliberate fail-closed release hold, not a claim that L3 is operational. Do not bypass it by setting client fields or by treating Didit L2 as L3.


## PostgreSQL foundation added (migration 114)

Migration `114_identity_l3_workflow.sql` adds metadata-only submission records, a one-open-submission-per-user constraint, moderation/expiry indexes, and append-only decision-event storage. Database guards restrict lifecycle transitions, prevent submission identity changes, prohibit self-review, and make the moderator decision fields immutable after a decision. Approval expiry is constrained to exactly six calendar months after approval. The integration schema test is included in `npm test`.

This is a schema foundation, not an operational L3 feature. There is still no upload authorization endpoint, private encrypted video object store, malware/transcode/metadata scanning worker, moderator UI/API, event-writing service, retention worker, or production query that loads the trusted L3 decision into the interaction gate. Therefore the fail-closed male interaction restriction remains in force. Do not manually populate approval fields or treat this migration as a completed verification workflow.


## Latest schema hardening (2026-11-01)

Migration 114 additionally requires a bounded reason code for every approval, rejection, and revocation. Once a video upload has been accepted, its checksum, MIME type, byte count, duration, upload timestamp, processing timestamp, and object identity cannot be replaced by a later update. The only allowed object-key mutation is a one-way purge operation that clears the key and records `media_purged_at` atomically. PostgreSQL integration coverage exercises attempted media replacement and the permitted purge transition, and verifies the decision-reason constraint.


## Trusted L3 lookup wired into restricted actions (2026-11-01)

All five restricted interaction handlers now read the current approved, unexpired L3 submission from PostgreSQL rather than relying on request fields or a hard-coded missing value. The lookup is performed inside the action transaction and takes a row-level `FOR SHARE` lock on the selected approval so a concurrent revocation/expiry transition cannot race past an in-flight restricted action; the revocation/expiry update waits for that action transaction to finish, and subsequent actions see the new state. Integration coverage creates a synthetic approved L3 row for the positive path and verifies that a second account with live L2 but no L3 remains denied for like, pass, and discovery undo. This does not enable L3 in production: the secure upload, scanning, moderator workflow and retention components are still absent.
