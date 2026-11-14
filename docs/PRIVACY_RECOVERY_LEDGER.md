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
