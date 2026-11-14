# Privacy recovery ledger

Status: architecture selected for implementation; not provisioned or production-ready.

## Decision

Use a small Cloudflare Worker + D1 database as an off-host privacy-event ledger, separate from the Vow PostgreSQL database and the Eurobyte VPS. Keep the event API independent of the Vow public/mobile API. Do not put profile content, email, phone, addresses, media paths, consent text, IP addresses, user-agent strings, or raw payment identifiers in this ledger.

Cloudflare Workers Free currently documents 100,000 requests/day and a 10 ms CPU limit. D1 Free currently documents 500 MB per database and 7 days of Time Travel; the Free plan enforces daily row read/write limits and rejects queries after a limit is reached. Workers Paid starts at $5/month. The ledger must treat any quota, availability, or authentication error as a hard failure; never fall back to a local-only outbox for an operation that requires a durable privacy event. See the official limits, pricing, and D1 FAQ:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/reference/faq/

D1 is off-host relative to the current Vow database/VPS, but it is not a second cloud-provider failure domain. Before Production, add an independently stored encrypted export of the ledger (or a second provider) and periodically prove that it can be restored. D1 Time Travel alone is not a long-term privacy-event archive.

## Event contract

The ledger accepts only a strict allowlist of versioned event types:
- `account_erasure_requested`
- `voice_intro_consent_withdrawn`
- `voice_intro_erasure_requested`
- `private_photo_erasure_requested`
- `identity_l3_consent_withdrawn`
- `ad_consent_revoked`
- `gift_order_consent_withdrawn`

Each event contains:
- a caller-generated UUID `event_id` for idempotency;
- `schema_version`;
- an allowlisted `event_type`;
- `subject_ref`: HMAC-SHA-256 of the internal user UUID using a dedicated stable ledger pseudonym key;
- optional `resource_ref`: HMAC-SHA-256 of an internal resource UUID for per-order events;
- caller-supplied UTC `occurred_at` and a server-recorded UTC `received_at`.

Never store raw UUIDs or the HMAC key in D1. The pseudonym key is separate from the request-authentication secret and must be escrowed separately. Losing either key makes reliable replay/matching impossible. Key rotation requires a versioned key identifier and dual-key lookup/replay window; do not silently replace a key.

The Worker verifies an HMAC-authenticated request over the exact raw body, rejects stale timestamps and oversized/unknown fields, enforces idempotency on `event_id`, and writes an append-only row. Updates and deletes are rejected by database triggers. Reads are authenticated, paginated by a monotonically increasing server sequence, and return the highest sequence as the ledger watermark. Repeated submission of the same event ID and identical payload is success; reuse with a different payload is a conflict.

## Ordering and fail-closed semantics

For an erasure or consent withdrawal:
1. Authenticate the user, validate password/ownership, acquire the same safety locks, and validate all domain preconditions first.
2. Compute pseudonymous references locally. Do not yet commit the destructive state change.
3. Append the privacy event to the remote ledger and wait for an authenticated durable acknowledgement.
4. Only after acknowledgement, execute and commit the existing PostgreSQL state transition, including consent state, media purge queue, session revocation, and related safety/billing logic.
5. If the remote ledger is unavailable, over quota, rejects the event, or the acknowledgement is ambiguous, do not perform the destructive PostgreSQL transition. Return a retryable error and alert operations.
6. If the remote event was accepted but the PostgreSQL transaction later fails, treat the remote event as an irrevocable privacy instruction. Retry the corresponding operation in the live database; on restore, replay it conservatively. This may result in a privacy action being applied even when the original API call did not return success; it must never result in restoring access or consent.

This ordering deliberately prefers a conservative extra deletion/revocation over resurrecting data or consent. Event append must be idempotent so retries are safe. Domain-specific preconditions (for example, gift dispatch/payment safety and Paddle cancellation) must be checked before appending an event; do not turn the ledger into a bypass around those workflows.

## Restore protocol

Every PostgreSQL backup manifest must record:
- snapshot creation time and PostgreSQL WAL/LSN recovery point;
- private photo, voice and L3 media snapshot/version identifiers;
- last acknowledged privacy-ledger sequence included in the snapshot.

A restored database and all restored private media remain isolated. Fetch every ledger event after the manifest watermark, verify signatures/schema/order, and replay idempotently before enabling API traffic, discovery, media serving, moderator playback, or user sessions. Treat erasure and withdrawal events as sticky deny instructions: a restored snapshot must never reinstate an earlier grant. If a user later re-granted a consent after the backup watermark, require a fresh explicit grant after restore rather than inferring it from the older snapshot. Replay must use the same domain deletion/withdrawal services and preserve billing, gift-safety, audit-retention and purge-queue invariants. Reconcile media separately: never mount a restored media volume into serving paths until all post-snapshot deletion events are applied and media objects are confirmed unavailable or queued for purge.

Fail closed if the manifest, ledger, keys, media snapshot IDs, event pagination, or replay verification is missing or inconsistent. Record the final ledger sequence and a signed restore attestation. Only then may an operator explicitly release the restored environment.

## Required implementation and acceptance tests

- Deployable Worker source, D1 schema/migrations, local deterministic tests and a documented deployment command.
- HMAC authentication, timestamp skew rejection, request-size/schema allowlists, idempotency, immutable rows, authenticated paginated export and watermark.
- API integration for account erasure, voice-intro consent withdrawal and clip erasure, private-photo erasure, L3 withdrawal, ad-consent revocation, and gift-order consent withdrawal. The remote append must precede each PostgreSQL mutation and must be mandatory in Production.
- Failure tests: remote unavailable, quota exceeded, invalid HMAC, stale timestamp, duplicate event, conflicting duplicate, DB rollback after remote acknowledgement, partial replay, replay retry, missing page, invalid sequence, wrong pseudonym key, and restore with post-snapshot erasure/withdrawal.
- End-to-end restore drill: create snapshot, perform erasure and each consent withdrawal, restore the older snapshot in an isolated disposable database, replay ledger events, and prove deleted accounts remain inaccessible, consent remains withdrawn, media remains unavailable, and replay can be repeated safely.
- Export the ledger to a separately controlled offsite destination and prove a restore from that export. Cloudflare D1 alone is not sufficient evidence of provider-independent disaster recovery.

## Operational boundary

This repository change does not create a Cloudflare account, deploy a Worker, create a D1 database, set secrets, or enable Production. Those actions require account access and credentials that are not present in the repository. Until the service is provisioned, configured, and tested, the existing recovery gate remains mandatory and the system must not claim privacy-safe disaster recovery.

## Encrypted ledger export implementation

The repository now includes `scripts/export-privacy-ledger.mjs` and the `npm run privacy-ledger:export` command. It reads the full event history using authenticated pages pinned to one immutable watermark, checks every sequence is contiguous from 1 through that watermark, and fails closed on missing pages, changing watermarks, malformed events, or API errors. The Worker supports the signed `through` query parameter so events appended during a multi-page export cannot silently change the export boundary.

The exporter writes a manifest followed by NDJSON events directly into the `age` process stdin. It does not persist plaintext ledger contents. It writes an encrypted archive and SHA-256 sidecar to a protected local directory. An operator must copy both artifacts to independently controlled offsite/immutable storage and verify the checksum. This code does not provision a Worker, configure secrets, upload artifacts, or enable a schedule.

This is an export primitive, not a complete restore/replay implementation. The production recovery gate remains closed until an isolated restore tool validates the encrypted archive and manifest, matches pseudonym keys, replays all applicable events idempotently into restored PostgreSQL and media, and proves the restored state cannot re-expose erased data or withdrawn consent.

## Isolated PostgreSQL staging (not domain replay)

Migration `187_privacy_recovery_event_staging.sql` adds an immutable PostgreSQL staging table for off-host events. `server/privacyRecoveryReplay.js` accepts an already verified, complete export and the ledger sequence recorded in the backup manifest. It validates the complete sequence from 1 through the export watermark, stages only events newer than the snapshot watermark in one transaction, and treats exact repeats as idempotent while rejecting sequence/event-ID collisions with different content. UPDATE and DELETE are blocked by database triggers.

This stage is deliberately non-destructive: it does not map pseudonymous references to user/resource IDs and does not delete accounts, revoke consent, purge media, alter ads, or change gift orders. It is a durable quarantine/import step, not replay completion. A restored environment must remain isolated until domain-specific replay services, media reconciliation, and a verified end-to-end recovery drill are implemented. The import helper must only receive events from a successfully checksum-verified and age-decrypted archive.



## Read-only pseudonym mapping (no replay)

`server/privacyRecoveryMapping.js` implements the next recovery gate. It uses the exact HMAC-SHA256 derivation used by the live API (the raw UUID string as UTF-8 input and the configured pseudonym key) to match staged subject references to restored users and resource references to the correct restored entity collection:
- voice-introduction erasure → `profile_voice_intros.id`;
- private-photo erasure → `photo_assets.id`;
- gift-order consent withdrawal → `gift_delivery_orders.id`;
- account erasure, voice consent withdrawal, L3 consent withdrawal and ad-consent revocation → subject only.

The function is read-only and accepts candidate rows supplied by a caller; it performs no SQL, filesystem or network operations. Every event is classified as matched, unmatched, ambiguous, or missing a required resource reference. It never guesses across entity types and returns null identifiers for unresolved matches. The pseudonym key must be the same key used when the event was appended. A wrong key therefore yields unmatched references and cannot silently select a different account.

This is a mapping report only. It does not modify restored records, invoke purge workers, or constitute consent/deletion replay. A future replay executor must reject the entire batch unless every event is fully resolved and domain-specific invariants are satisfied. L3 media cleanup remains a subject-level workflow: the existing domain procedure must locate every retained L3 submission for that user and enqueue its purge jobs rather than assuming the event identifies one submission.


## Isolated read-only recovery inventory

The command `npm run privacy-recovery:inventory` produces a mapping-readiness report from an already restored, isolated PostgreSQL staging database. It requires all of the following: `PRIVACY_RECOVERY_RESTORE_ISOLATED=true`, a non-production `NODE_ENV`, `DATABASE_URL`, and the original `PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY`. It opens a repeatable-read, read-only transaction and reads only IDs from users, voice intros, photos and gift orders plus staged privacy events.

The report contains candidate counts, event-type/status aggregates and unresolved ledger sequence numbers. It never emits raw user/resource IDs, pseudonym references, storage paths, addresses or event payloads. A sequence gap or any unresolved/ambiguous mapping prevents a ready result. The command performs no SQL writes, domain actions, filesystem operations, media deletion, consent changes or account changes.

This is still only a preflight inventory. A ready report is not permission to replay events or release the restored environment. Account erasure, L3 revocation, advertising consent and gift-order withdrawal each require their existing domain workflows to be integrated and verified separately. In particular, gift order state/payment/address-vault handling must not be bypassed, and account deletion must not be reduced to deleting a users row.
