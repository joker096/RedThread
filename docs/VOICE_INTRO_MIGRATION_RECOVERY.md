# Voice introduction ciphertext migration and recovery

## Scope and activation status

This document describes the guarded recovery implementation for re-encrypting private voice-introduction ciphertext from the legacy `VOWVOICE1` envelope to the versioned `VOWVOICE2` envelope.

The repository currently contains the journal, lease repository, encrypted file staging helpers, and a single-record worker library. **The worker is not registered as a scheduler, API route, startup task, or executable CLI.** Importing the module does not run a migration. No migration is started automatically.

Do not connect this worker to a production scheduler until the release gates below are explicitly approved and tested. There is no `--apply` command in this change.

## Required key material

The worker requires a versioned keyring with:

- `VOICE_INTRO_KEYRING`: JSON object mapping key IDs to 64-character hexadecimal AES-256 keys.
- `VOICE_INTRO_ACTIVE_KEY_ID`: key ID to use for new `VOWVOICE2` ciphertext.
- `VOICE_INTRO_ENCRYPTION_KEY`: retained legacy key for authenticating existing `VOWVOICE1` ciphertext.

Example shape only; never commit actual key material:

```json
{
  "voice-legacy": "<64-hex-character-key>",
  "voice-next": "<64-hex-character-key>"
}
```

The journal stores only the target key ID, not key material. The legacy key must remain available through the rollback window and until all dependent backups and restore procedures have been verified. Do not replace or delete the legacy key as part of this worker change.

## State machine

1. `planned`: source path, source ciphertext SHA-256, envelope format and target key ID are fixed in the journal.
2. `source_authenticated`: the source ciphertext checksum and AES-GCM authentication have passed.
3. `staged_authenticated`: a new encrypted file has been written with exclusive creation, mode `0600`, fsync, checksum and decryption verification.
4. `reference_switched`: the profile storage reference and journal transition are committed in one PostgreSQL transaction.
5. `rollback_window`: the old source file is retained; the deadline is stored in PostgreSQL.
6. `completed`: after the rollback deadline, the source file is enqueued in the existing private voice purge queue in the same transaction as the terminal journal transition.
7. `rolled_back`: if the staged ciphertext fails verification while the source remains authentic, the profile reference is restored to the source and the staged file is queued for purge atomically.

The journal event trigger records each state transition in the append-only event table. Version compare-and-swap and lease token/generation checks fence stale workers.

## File safety and crash recovery

- Storage root must be a real directory, not a symlink or a path containing symlinked ancestors.
- Source and staged ciphertext files must be regular files with no group/other permission bits.
- Source files are opened with no-follow semantics and checked against the journal SHA-256 before decryption.
- Plaintext is held in memory only and buffers are cleared after each processing step; it is never written to a temporary file.
- Staging uses a deterministic per-journal UUID filename and exclusive creation. If a worker crashes after writing the staged file but before the journal transition, the next attempt authenticates and reuses the existing staged file instead of overwriting it.
- The old source ciphertext remains available throughout the rollback window. It is not removed by the migration worker directly; the existing purge worker handles queued deletion and retries.
- If the source cannot be authenticated, the worker fails closed and does not switch the profile reference.
- If the staged file is corrupt before the reference switch, processing fails closed and the live profile reference remains on the source; the worker does not overwrite or silently discard the staged artifact. If corruption is detected after the reference switch and the source remains authentic, the worker restores the source reference and queues the staged file for deletion.

## Worker behavior

`processNextVoiceIntroMigration(pool, options)` processes at most one leased journal row per invocation. It advances only through guarded transitions and returns a non-sensitive status such as `idle`, `rollback_window`, `completed`, `rolled_back`, `cas_conflict`, or `lease_lost`.

The rollback window defaults to 24 hours. The PostgreSQL clock is authoritative for the deadline. The worker renews its lease before each processing step and releases the lease best-effort on exit. Unexpected filesystem, key, or database errors are thrown to the caller; the current profile reference remains unchanged unless the atomic switch transaction commits.

This library function is not yet exposed through a CLI or scheduler. Do not invoke it against live user media as part of ordinary CI.

## Automated validation

The focused files are included in the default test suite:

- `server/voiceIntroMigrationRepository.test.js`
- `server/voiceIntroMigrationRepository.integration.test.js`
- `server/voiceIntroMigrationFiles.test.js`
- `server/voiceIntroMigrationWorker.integration.test.js`

The PostgreSQL integration tests are skipped when `DATABASE_URL` is absent. CI uses a disposable PostgreSQL 16 service and temporary filesystem directories. Tests create synthetic encrypted fixtures; they do not use user recordings or the VPS.

## Release gates not satisfied by this implementation

Before any live execution:

- Provision and escrow both the legacy and target keys outside the repository, with independent recovery copies.
- Verify encrypted PostgreSQL and private-media backups, including a restore drill with the exact keyring.
- Confirm persistent private storage and tested backup consistency for the media volume.
- Run the complete migration against synthetic fixtures in an isolated environment and review all journal events, reference changes, rollback behavior and purge queue outcomes.
- Establish an explicit rollback-window policy and operational ownership.
- Add alerting and a controlled operator entrypoint only after the above gates pass.

Until then, keep the worker unscheduled and do not change live profile references or audio files.
