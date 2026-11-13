# Deleted-account data erasure

When an account transitions to `users.status = 'deleted'`, database-level safeguards provide a backstop even when the transition does not originate from the HTTP deletion handler.

The database trigger:
- Replaces the email with a unique, non-deliverable tombstone address and clears the password hash, phone number/verification timestamp, trial and Premium entitlements.
- Scrubs birth date, gender, location, biography, photo URLs, occupation, education, languages, relationship intent, child/family disclosures, family values and profile visibility.
- Retains immutable safety-screening evidence with its opaque `user_ref` snapshot; the live `user_id` remains linked to the tombstone and becomes null only on physical user-row deletion. It deletes photo metadata and places each private photo path in `private_photo_purge_queue`; the private-photo worker must unlink the file and the queue backlog/failures must be monitored.
- Moves in-flight L3 submissions to a terminal withdrawn/revoked state so the existing L3 media-purge trigger enqueues encrypted media for deletion. The L3 purge worker must complete the job; retain the object key until deletion is confirmed.
- Makes the deleted-account tombstone terminal. It cannot be reactivated because its identity fields have intentionally been erased; a returning user must register a new account.

## Private-media purge operations

The private photo and encrypted voice-introduction purge workers are separate one-shot jobs. Run them from the deployment scheduler after migrations are applied, with the same mounted private storage volumes used by the API:

```bash
npm run photos:purge
npm run voice-intros:purge
```

Both workers process bounded batches and retain failed queue rows for exponential-backoff retry. Exit code `0` means the batch had no deletion failures; a non-zero exit must trigger scheduler alerting. The photo worker exits with code `2` when any item was retried after a filesystem failure; configuration/database failures exit non-zero. The voice worker follows the same failure-signalling contract.

Monitor queue age and attempts, not only worker process health:

```sql
SELECT count(*) AS pending,
       count(*) FILTER (WHERE next_attempt_at <= now()) AS due,
       max(created_at) AS oldest_created_at,
       max(attempts) AS max_attempts
FROM private_photo_purge_queue;

SELECT count(*) AS pending,
       count(*) FILTER (WHERE next_attempt_at <= now()) AS due,
       max(created_at) AS oldest_created_at,
       max(attempts) AS max_attempts
FROM private_voice_intro_purge_queue;
```

A zero queue count confirms only that the database queue is empty; it does not prove that all backups, replicas, object-store versions, or external copies have expired. Include private media volumes and backup retention in the approved erasure process. Do not configure these jobs on the existing shared VPS until the Vow service volumes, database credentials, and scheduler isolation are explicitly provisioned.

## L3 audit evidence migration prerequisite

Migration `134_deleted_profile_personal_data_purge.sql` checks for legacy deleted-account L3 submissions that have no remaining media object but still have media-access audit events. If such evidence exists and migration `136_adjustment_and_l3_access_evidence.sql` is not recorded as applied, migration 134 aborts before changing schema or data. Apply migration 136 through the approved deployment procedure, then rerun the migration runner. Do not manually insert a row into `schema_migrations` to bypass this check.

A clean-database CI migration run does not prove that migration 136 has been applied to a deployed database containing historical L3 records. Verify the target database's migration journal before release.

## Important boundary

The database trigger is a safety backstop, **not a replacement for the authenticated account-deletion workflow**. The HTTP workflow additionally cancels Paddle billing where required, revokes sessions, removes identity-verification and consent records, clears account preferences and interaction records, redacts the deleted user's messages, closes matches, and applies gift-payment safety reconciliation. Any future administrative/background deletion workflow must call the same deletion service or explicitly perform these additional steps. A direct SQL status update alone does not cancel an external Paddle subscription.

## Limited retention and legal review

A minimal non-discoverable relational tombstone remains for referential integrity. Paddle customer/subscription and transaction references, user reports, moderation decisions, gift-order/payment evidence and related audit records may be needed for payment reconciliation, disputes, abuse investigations or legal obligations. They must be access-restricted and retained only for an approved, jurisdiction-specific period. The repository does not yet define those retention periods; obtain legal approval before production launch. This document is not a legal determination that records may be kept indefinitely.
