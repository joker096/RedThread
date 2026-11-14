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
