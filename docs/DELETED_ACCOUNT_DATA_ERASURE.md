# Deleted-account data erasure

When an account transitions to `users.status = 'deleted'`, database-level safeguards provide a backstop even when the transition does not originate from the HTTP deletion handler.

The database trigger:
- Replaces the email with a unique, non-deliverable tombstone address and clears the password hash, phone number/verification timestamp, trial and Premium entitlements.
- Scrubs birth date, gender, location, biography, photo URLs, occupation, education, languages, relationship intent, child/family disclosures, family values and profile visibility.
- Deletes transient safety-screening results and photo metadata. It places each private photo path in `private_photo_purge_queue`; the private-photo worker must unlink the file and the queue backlog/failures must be monitored.
- Moves in-flight L3 submissions to a terminal withdrawn/revoked state so the existing L3 media-purge trigger enqueues encrypted media for deletion. The L3 purge worker must complete the job; retain the object key until deletion is confirmed.
- Makes the deleted-account tombstone terminal. It cannot be reactivated because its identity fields have intentionally been erased; a returning user must register a new account.

## Important boundary

The database trigger is a safety backstop, **not a replacement for the authenticated account-deletion workflow**. The HTTP workflow additionally cancels Paddle billing where required, revokes sessions, removes identity-verification and consent records, clears account preferences and interaction records, redacts the deleted user's messages, closes matches, and applies gift-payment safety reconciliation. Any future administrative/background deletion workflow must call the same deletion service or explicitly perform these additional steps. A direct SQL status update alone does not cancel an external Paddle subscription.

## Limited retention and legal review

A minimal non-discoverable relational tombstone remains for referential integrity. Paddle customer/subscription and transaction references, user reports, moderation decisions, gift-order/payment evidence and related audit records may be needed for payment reconciliation, disputes, abuse investigations or legal obligations. They must be access-restricted and retained only for an approved, jurisdiction-specific period. The repository does not yet define those retention periods; obtain legal approval before production launch. This document is not a legal determination that records may be kept indefinitely.
