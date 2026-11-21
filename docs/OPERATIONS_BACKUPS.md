# PostgreSQL backup and restore runbook

## Create a backup

Use a deployment secret manager for DATABASE_URL and BACKUP_AGE_RECIPIENT; do not commit credentials. Install PostgreSQL client tools and age on a trusted Linux backup host. Generate an age recipient key pair and keep the private identity offline or in a dedicated secret manager; only the public recipient belongs in BACKUP_AGE_RECIPIENT.

## Runtime writer admission for the application stack

Before starting any API or worker container, provision one persistent host lock directory shared by every Compose service built from the API image. Do not place it under `/run` or another volatile filesystem: the maintenance marker must survive a host reboot so an interrupted deletion/restore cannot silently reopen writers.

```bash
# Choose and record one numeric GID consistently across every host.
PRIVACY_RECOVERY_WRITER_GID='<numeric-writer-group-id>'
PRIVACY_RECOVERY_WRITER_LOCK_DIR=/var/lib/vow-privacy-admission
groupadd --system --gid "$PRIVACY_RECOVERY_WRITER_GID" vow-privacy-writers
install -d -o root -g "$PRIVACY_RECOVERY_WRITER_GID" -m 2750 "$PRIVACY_RECOVERY_WRITER_LOCK_DIR"
install -o root -g "$PRIVACY_RECOVERY_WRITER_GID" -m 0640 /dev/null "$PRIVACY_RECOVERY_WRITER_LOCK_DIR/writers.lock"
```

Set `PRIVACY_RECOVERY_WRITER_GID` and `PRIVACY_RECOVERY_WRITER_LOCK_DIR` in the protected Compose environment. Compose mounts the pre-existing directory read-only into every API, migration, retention and purge container, adds only the configured supplementary group, and refuses to create a missing host path. The API image entrypoint acquires the shared lock before running any command; each database-writing Node entrypoint independently verifies the inherited FD 9 and fails closed when invoked directly. The guard activates whenever `NODE_ENV=production` (or `PRIVACY_RECOVERY_REQUIRE_ADMISSION=true`), so host-managed production services must also set `PRIVACY_RECOVERY_WRITER_LOCK_FILE=/var/lib/vow-privacy-admission/writers.lock` and `PRIVACY_RECOVERY_WRITER_GID` and launch through `privacy-recovery-admission.sh writer -- ...`. A direct `node ...` or `npm run ...` production launch without FD 9 is rejected. Runtime scripts remain root-owned inside the image.

Do not start or restart the application stack until the host directory and lock file have the exact ownership and modes above. The Docker daemon administrator can always override container entrypoints or mount arbitrary files; therefore restrict Docker socket/context access to the trusted deployment and maintenance operators. The admission protocol protects ordinary Compose starts, automatic restarts and direct Node invocations by the unprivileged service account; it is not a security boundary against a hostile host root or Docker administrator.

Before any backup, provision the dedicated writer-admission lock on the trusted host. The lock directory must be owned by root and the configured writer group with mode `2750`; the lock file must be root-owned by that group with mode `0640`. Add the backup service account to the group and set the numeric GID. The drain controller is required for maintenance mode; a backup writer only needs the lock and group configuration.

```bash
export PRIVACY_RECOVERY_WRITER_LOCK_FILE=/var/lib/vow-privacy-admission/writers.lock
export PRIVACY_RECOVERY_WRITER_GID='<numeric-writer-group-id>'
export BACKUP_DIR=/secure/backups
export BACKUP_RETENTION_DAYS=30
export BACKUP_AGE_RECIPIENT='age1...'
npm run backup:postgres
```

The npm entrypoint invokes `privacy-recovery-admission.sh writer`; the backup script independently verifies that inherited FD 9 refers to the configured lock inode and carries a live shared flock. Direct/manual invocation of `scripts/backup-postgres.sh` without that descriptor fails closed. The shared lock remains held for the complete pg_dump-to-age stream, so exclusive privacy maintenance cannot begin while the backup is reading the database. `backup:private-media` and `backup:bundle` use the same admission protocol; the bundle holds one shared lock across both database and media capture. Do not remove the FD checks or call the underlying scripts outside the admission wrapper.

The script streams pg_dump directly into age, so plaintext database contents are not written to disk. It creates a custom-format encrypted backup, restricts local permissions, writes a SHA-256 checksum and removes encrypted local backups past the configured retention. It refuses to run without age and a recipient. A local backup is not a disaster-recovery plan: copy the encrypted artifact to off-site/object storage with restricted access and lifecycle policies.

## Restore drill

A restore must target a newly provisioned, isolated staging database. The wrapper never creates, drops, truncates or cleans a database: it checks that the target has no user schemas or objects and refuses to continue otherwise. It also verifies the connected database name uses the dedicated `vow_restore_test` or `vow_restore_dst_` naming convention, so a normal application/production database name is rejected before restore. Do not point it at the live application database.

The restore path uses three separate identities; do not reuse one role for all stages:

1. A short-lived bootstrap/admin identity provisions the database and roles. It is never supplied to `pg_restore` or the verifier.
2. A dedicated `NOLOGIN` owner role owns the empty staging database and all restored objects. A dedicated restore LOGIN is granted membership with `INHERIT FALSE, SET TRUE` and no other role memberships. It must not be a superuser, database/schema creator, or have TEMP or direct object write privileges. The wrapper verifies this contract and runs `pg_restore --role="$RESTORE_OWNER_ROLE"`; it refuses to proceed if the owner is not the database owner, is login-capable/elevated, or the restore login inherits owner rights.
3. A separate read-only verifier LOGIN is provisioned after restore. Grant it only the required SELECT privileges on restored schemas, relations and sequences. It must not be a member of owner or restore roles and must not have TEMP, CREATE, or write privileges. The privacy-recovery target guard remains strict; do not run it as the restore login or owner.

Example provisioning SQL (replace suffixes and use a secret manager for the password; run as the isolated staging bootstrap administrator):

```sql
CREATE ROLE vow_restore_owner_example NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE vow_restore_login_example LOGIN PASSWORD '<secret>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT vow_restore_owner_example TO vow_restore_login_example WITH INHERIT FALSE, SET TRUE;
CREATE DATABASE vow_restore_dst_example OWNER vow_restore_owner_example;
GRANT CONNECT ON DATABASE vow_restore_dst_example TO vow_restore_login_example;
REVOKE TEMPORARY ON DATABASE vow_restore_dst_example FROM PUBLIC;
```

The database owner role receives its database/schema ownership capabilities; the restore LOGIN does not inherit them. Do not grant the verifier membership in either role. After restore, provision the verifier's narrow read-only grants and validate it through an independent connection before any inventory/replay operation.

Keep the age identity out of the application host and shell history. Supply it through a protected secret file and use a separate `RESTORE_DATABASE_URL` so the restore target cannot be confused with the application's `DATABASE_URL`:

```bash
sha256sum --check /secure/backups/vow-postgres-YYYYMMDDTHHMMSSZ.dump.age.sha256
RESTORE_DATABASE_URL='postgresql://restore_login@staging-db/vow_restore_test' \\
RESTORE_OWNER_ROLE='vow_restore_owner_example' \
RESTORE_CONFIRM_STAGING=I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE \
ARCHIVE_FILE=/secure/backups/vow-postgres-YYYYMMDDTHHMMSSZ.dump.age \
AGE_IDENTITY_FILE=/secure/keys/vow-backup-identity.txt \
bash scripts/restore-postgres.sh
```

The wrapper validates that archive, checksum and identity are regular non-symlink files, verifies SHA-256 before connecting to PostgreSQL, requires an empty target, then streams age decryption directly to `pg_restore`. It does not write a plaintext dump to disk and does not use `--clean`, `DROP DATABASE`, or overwrite existing objects. It uses `--role="$RESTORE_OWNER_ROLE" --exit-on-error --single-transaction --no-owner --no-acl` so restored objects belong to the dedicated NOLOGIN owner and a failed restore rolls back instead of leaving a partially restored staging database; pipeline failures are fatal. Never put the private identity or database password in a command committed to the repository.

Automated regression coverage is included in `npm test`: `scripts/restore-postgres.test.js` exercises checksum, empty-target and pipeline failure handling with isolated fake client commands; `scripts/restore-postgres.integration.test.js` performs a real encrypted backup and restore against disposable PostgreSQL databases using `age`, `pg_dump` and `pg_restore`, with a non-inheriting restore LOGIN and NOLOGIN database/object owner. `scripts/restore-postgres-roles.integration.test.js` separately proves the PostgreSQL 16 role membership, object ownership and read-only verifier boundaries. The CI job installs these tools and runs the integration drill when `DATABASE_URL` is configured. It verifies restored rows and confirms that a second restore into a now-non-empty target is refused without changing existing data. A production-grade restore drill must additionally verify application invariants and record elapsed recovery time.

Verify schema/migrations, account access, profiles, matches, messages, photo metadata and billing state. Do not restore production data into an unapproved development environment. Delete staging copies after verification. The database restore does not restore private media; use the separate private-media restore procedure and reconcile deletion tombstones, consent and moderation state before enabling access.

## Backup and deletion-queue health report

Run the read-only operations report from a trusted scheduler or monitoring runner with a read-only PostgreSQL account and access to the encrypted backup directories:

```bash
DATABASE_URL='postgresql://ops_reader@db-host/vow_app' \
OPS_POSTGRES_BACKUP_DIR=/secure/backups/postgres \
OPS_PRIVATE_PHOTO_BACKUP_DIR=/secure/backups/private-photos \
OPS_PRIVATE_VOICE_BACKUP_DIR=/secure/backups/private-voice-intros \
npm run ops:health
```

The report covers the private-photo, private-voice-introduction and identity-L3 media purge queues. It returns pending/due/retrying/failed counts, oldest outstanding work and maximum attempts without exposing user IDs or storage paths. It also checks the latest encrypted PostgreSQL/photo/voice backup in each configured directory, verifies that the checksum sidecar exists and contains a well-formed SHA-256 digest, and measures backup age.

Exit codes are suitable for cron/monitoring integration: `0` healthy, `1` warning, `2` critical or report failure. Defaults warn when a queue has more than 100 pending jobs or its oldest job is at least 60 minutes old; failed L3 purge jobs and work older than 24 hours are critical. Backup age warns at 26 hours and becomes critical at 48 hours. Thresholds are configurable in `scripts/ops-health-report.js`.

The report checks checksum-sidecar presence and format; it deliberately does not re-hash large backup files on every monitoring run. Verify the actual bytes of every configured encrypted artifact with:

```bash
npm run backup:verify
```

This command streams each encrypted archive through SHA-256, compares it with its sidecar (including the expected filename), rejects symlinks and fails on missing/malformed/mismatched artifacts. Exit code `0` means all three backup locations were configured and all matching artifacts verified; `1` means a verification failure; `2` means backup configuration is missing or incomplete. Schedule it after backup creation and before off-site replication; continue to perform isolated restore drills. When `AGE_IDENTITY_FILE` points to a regular, non-symlink age identity, the verifier also streams authenticated decryption directly into `pg_restore --list` for PostgreSQL custom archives or `tar --list` for private-media archives; plaintext is never written to disk. Without that identity the report explicitly returns `cryptographic_validation: not_configured`, so checksum-only verification must not be represented as proof of decryptability or restore readiness.
 An unset backup directory is reported as `not_configured`, not as proof that a backup exists.

Healthchecks.io's Hobbyist plan is $0 and includes 20 monitored jobs, but the provider describes it as intended for personal infrastructure; its FAQ says commercial use is tolerated while expecting businesses to eventually upgrade. Treat it as a development/pre-launch option only unless the provider confirms suitability for Vow. Create one check for the Vow operations report and store its base Ping URL as a secret named `OPS_HEALTHCHECKS_PING_URL` on the trusted scheduler. The report sends a success POST only when healthy and a `/fail` signal for warning/critical results; it sends only aggregate queue counts and backup freshness metadata, not user IDs or filesystem paths. The integration accepts HTTPS URLs on `hc-ping.com` only.

Once all three backup locations are actually configured, set `OPS_REQUIRE_BACKUPS=true` so missing PostgreSQL/photo/voice backup paths become critical instead of `not_configured`. Example protected cron schedule (15-minute cadence):

```cron
*/15 * * * * cd /srv/vow && DATABASE_URL='...' OPS_REQUIRE_BACKUPS=true OPS_POSTGRES_BACKUP_DIR=/secure/backups/postgres OPS_PRIVATE_PHOTO_BACKUP_DIR=/secure/backups/photos OPS_PRIVATE_VOICE_BACKUP_DIR=/secure/backups/voice OPS_HEALTHCHECKS_PING_URL='https://hc-ping.com/...' npm run ops:health
```

Configure the Healthchecks check for a 15-minute schedule with a suitable grace period. Do not put the ping URL or database credentials in the repository or command history; use a protected environment file or secret manager. The ping is outbound, so no inbound port or public PostgreSQL access is required.

The repository does not activate a scheduler, webhook, external monitoring account or database exposure. Before launch, run the report from a trusted external scheduler/monitoring runner (or a protected host cron) using secrets. Do not expose PostgreSQL publicly just to make monitoring work; prefer a private tunnel or an outbound agent.

## Production checklist

- Schedule the script using the deployment scheduler or cron; scheduling is not enabled automatically by this repository.
- Alert on failed or missing backups.
- Keep database backups encrypted, access-controlled and separate from the application host.
- Include the private photo volume in a separate backup plan or use a managed object store with versioning and lifecycle rules.
- Define recovery point objective, recovery time objective, retention and deletion policy.
- Run a restore drill before public launch and regularly afterward.

## Encrypted private-media backup

The application stores private photos and voice introductions in separate persistent volumes. Back them up separately from PostgreSQL using the same off-host age recipient policy:

```bash
chmod +x scripts/backup-private-media.sh
PRIVATE_MEDIA_DIR=/srv/vow/private-media \\
BACKUP_DIR=/secure/backups/private-media \\
BACKUP_RETENTION_DAYS=30 \\
BACKUP_AGE_RECIPIENT='age1...' ./scripts/backup-private-media.sh
```

Run once for each private-media volume (for example, the photo volume and the voice-introduction volume). The script rejects a symlinked root and symlinks within the tree, streams a tar archive directly into age without writing a plaintext archive, restricts artifact permissions, writes a SHA-256 checksum, and applies local retention. The backup directory must be outside the source media tree. Store the age identity separately from both the application host and encrypted backups.

### Consistent backup window

A PostgreSQL dump and a media archive taken at unrelated times are not an atomic snapshot. Before a coordinated recovery point, pause media uploads, replacements, account-deletion purges and moderation actions that change media references; then create the database and media backups, verify all checksums, and resume operations. Prefer provider-level point-in-time snapshots or immutable object versions when available. Record the UTC time and the exact database/media artifact names together. Never claim a consistent recovery point if writes were not quiesced or a coordinated snapshot was not used.

### Restore private media into an isolated staging directory

First verify the artifact checksum. Restore only into a new, empty directory on an isolated host; do not extract directly over a live volume:

```bash
sha256sum --check /secure/backups/private-media/vow-private-media-YYYYMMDDTHHMMSSZ.tar.age.sha256
install -d -m 0700 /srv/vow/restore/private-media
age --decrypt --identity /secure/keys/vow-backup-identity.txt \\
  /secure/backups/private-media/vow-private-media-YYYYMMDDTHHMMSSZ.tar.age \\
  | tar --extract --file=- --directory=/srv/vow/restore/private-media --no-same-owner --no-same-permissions
```

Prefer the automated restore wrapper so checksum verification and staging-directory safeguards are applied consistently:

```bash
mkdir -p /srv/vow/restore
ARCHIVE_FILE=/secure/backups/private-media/vow-private-media-YYYYMMDDTHHMMSSZ.tar.age \\
AGE_IDENTITY_FILE=/secure/keys/vow-backup-identity.txt \\
RESTORE_DESTINATION=/srv/vow/restore/private-media \\
bash scripts/restore-private-media.sh
```

The destination must be a new path beneath an existing, real (non-symlink) parent directory. The script verifies the SHA-256 digest before decryption, requires regular non-symlink archive/checksum/identity files, refuses existing destinations (including symlinks), creates the staging directory with mode 0700, and streams age output directly into tar without writing a plaintext archive. If decryption or extraction fails, it removes the staging directory it created. It never restores over an existing directory. Run it only on an isolated host with a trusted archive and key; after restoration, reconcile deletion tombstones, consent, moderation and application references before mounting any data.

Validate the restored file count, sizes, expected UUID-based filenames, and application metadata references before mounting the restored directory. Restore voice introductions only when the matching dedicated `VOICE_INTRO_ENCRYPTION_KEY` is available; the key is not included in the media archive. Verify authenticated decryption of a controlled test recording with the matching key. Losing or rotating that key without a tested re-encryption/recovery procedure makes existing recordings unreadable.

#### Voice-introduction key escrow and rotation boundary

The voice media encryption key and the age backup identity are separate secrets with different purposes. The age identity decrypts backup archives; `VOICE_INTRO_ENCRYPTION_KEY` decrypts individual voice recordings after the media archive has been restored. Escrow both independently. Never derive one from the other, store either beside the encrypted backups, or put either in Git, CI logs, shell history or the application image.

Generate a dedicated 32-byte key only in a trusted secret-management environment:

```bash
openssl rand -hex 32
```

Store the exact 64-character hexadecimal value in the deployment secret manager and maintain a separately controlled offline recovery copy. Restrict access to the service identity and designated recovery custodians; record key ownership, creation date and recovery procedure without recording the key itself. Before relying on the escrow copy, retrieve it in an isolated recovery environment and authenticate-decrypt a controlled, non-user test recording. Do not print decrypted audio or key material in logs.

**Versioned key envelope is now supported for new writes, but bulk rotation is not yet enabled.** New deployments may configure `VOICE_INTRO_KEYRING` as a JSON object mapping stable key IDs to 64-character hexadecimal AES-256 keys, and `VOICE_INTRO_ACTIVE_KEY_ID` to the key ID used for new recordings. Keep `VOICE_INTRO_ENCRYPTION_KEY` configured with the original legacy key for every existing `VOWVOICE1` recording until the inventory has been migrated and independently verified. New writes use the authenticated `VOWVOICE2` envelope, which binds the key ID into AES-256-GCM additional authenticated data; reads select the matching key by ID. Unknown IDs fail closed. The legacy key and each keyring key are separate secret values and must remain in the secret manager, never in Git or backup archives.

Example shape (use placeholders only; never commit real keys):

```bash
VOICE_INTRO_KEYRING='{"voice-2026-01":"<64-hex-key>","voice-2026-02":"<64-hex-key>"}'
VOICE_INTRO_ACTIVE_KEY_ID='voice-2026-02'
VOICE_INTRO_ENCRYPTION_KEY='<legacy-64-hex-key>'
```

This format support alone does **not** migrate existing recordings or authorize removal of the legacy key. Bulk rotation remains disabled until a separately reviewed migration inventories every retained database reference, decrypts each source, writes and authenticates a staged versioned ciphertext, verifies all staged files, then safely switches file/metadata references with a recoverable journal and rollback window. Keep the old key available until the migration is complete and the rollback window is formally closed. Do not rotate by simply changing an environment variable. If the key is suspected compromised, suspend voice upload/playback and follow an approved incident-specific migration; do not silently discard old key material.


### Read-only voice recording inventory

Before planning any re-encryption, run the inventory from a trusted host that can reach the database and the mounted private voice volume:

```bash
DATABASE_URL='...' VOICE_INTRO_STORAGE_DIR=/srv/vow/private-voice npm run voice-intros:inventory
```

The command opens a PostgreSQL `REPEATABLE READ READ ONLY` transaction and reads only `storage_path` values from `profile_voice_intros` and `private_voice_intro_purge_queue`. It scans UUID-named encrypted files in the configured voice directory, reads only a short ciphertext header, and reports aggregate counts for legacy `VOWVOICE1`, versioned `VOWVOICE2` key IDs, missing references, queued files, orphan files, malformed envelopes and unsafe paths. It does not decrypt audio, print user IDs or file paths, write database rows, modify files, or remove anything. Exit code 2 indicates missing references, unsafe paths or malformed ciphertext; exit code 1 indicates a configuration/runtime failure.

Run it with a least-privilege database account that can only `SELECT` from the two voice tables. The database transaction is explicitly read-only as a second guard. Review any discrepancy and reconcile deletion/consent state before authorizing a separate migration. Inventory counts are a snapshot, not a lock: pause uploads, replacements, moderation transitions and purge workers during a future migration window, then take a fresh inventory immediately before it starts. This inventory is not proof that any key can decrypt a recording; it only identifies envelope versions and key IDs.

### Deletion and retention safety

Backups are immutable historical copies and may contain media that has since been deleted from the live service. Restrict access, use short documented retention, and expire off-site copies according to the approved privacy/deletion policy. A restore must not silently re-publish old media: keep the restored service isolated, replay account-deletion and media-purge tombstones from a separately retained deletion ledger where available, and reconcile against current consent and moderation state before enabling access. Do not restore a historical media volume into a live service without this reconciliation.

## Recovery validation

A backup is not considered verified merely because the command exited successfully. A restore drill must use a fresh isolated PostgreSQL database and fresh media directories, verify checksums before decryption, restore both database and media, run schema/migration and application-level integrity checks, and confirm that private media remains inaccessible without authorization and the correct encryption key. Record the recovery point, elapsed restore time, missing/orphaned media counts, and test outcome. Production scheduling, off-site replication, alert delivery, key escrow, and a deletion ledger are deployment responsibilities and are not activated by these scripts.



### Read-only V1 → V2 migration preflight

After the inventory is clean and every purge-queued recording has been reconciled, run the additional authentication preflight from a trusted maintenance host:

```bash
DATABASE_URL='postgresql://voice_ops_reader@db-host/vow_app' \
VOICE_INTRO_STORAGE_DIR=/srv/vow/private-voice \
VOICE_INTRO_KEYRING='{"voice-2026-02":"<64-hex-key>"}' \
VOICE_INTRO_ACTIVE_KEY_ID='voice-2026-02' \
VOICE_INTRO_ENCRYPTION_KEY='<legacy-64-hex-key>' \
npm run voice-intros:migration-preflight
```

Use a database role with only `SELECT` privileges on `profile_voice_intros` and `private_voice_intro_purge_queue`. The command uses a repeatable-read, read-only transaction; opens each retained encrypted file without following symlinks; authenticates V1 with the legacy key or V2 with its key ID; then encrypts and decrypts a candidate V2 envelope in memory to verify the configured active key. Plaintext and temporary candidate buffers are cleared after each record. The report contains aggregate counts only and never emits user IDs, file paths, key IDs or audio bytes.

This is a **preflight only**: it does not create staged files, update references, write a journal, pause workers, or modify database rows. It fails closed on missing/unsafe files, authentication failures, duplicate references, or any reference that is also queued for purge. A successful result is not authorization to migrate and is not a substitute for a coordinated maintenance window and tested backups.

The actual migration remains a separate, explicitly approved operation. Before it is designed or run, uploads, replacements, moderation transitions and purge workers must be paused; take and verify coordinated database/media backups; preserve V1 ciphertext and the legacy key for rollback; and establish a recoverable journal and crash-resume procedure. Never remove V1 ciphertext or the legacy key automatically. Do not run a migration against live or production storage without explicit approval.



## Persistent migration journal and guarded worker

Migrations `234_voice_intro_migration_journal.sql` and `235_voice_intro_migration_worker_leases.sql` provide the durable journal, append-only transition history, optimistic versioning, and fenced worker leases. The repository layer implements atomic claim with `FOR UPDATE SKIP LOCKED`, lease renewal/release, compare-and-swap transitions, and transactional profile-reference switching, rollback, and completion with purge-queue enqueueing.

The guarded worker and encrypted-file helpers are implemented in:

- `server/voiceIntroMigrationWorker.js`
- `server/voiceIntroMigrationRepository.js`
- `server/voiceIntroMigrationFiles.js`
- `server/voiceIntroStorage.js`

The worker processes at most one leased journal row per call to `processNextVoiceIntroMigration(pool, options)`. It authenticates the source ciphertext, stages and authenticates a versioned encrypted file, switches the database reference and journal state atomically, retains the original through the rollback window (24 hours by default), and then enqueues the old ciphertext for the existing purge worker. If staged ciphertext becomes invalid after the reference switch while the original remains authentic, it attempts an atomic reference rollback and queues the staged file for purge. Lease tokens plus monotonically increasing generations fence stale workers.

Filesystem handling rejects symlinked storage-root ancestors, unsafe/non-regular ciphertext files and group/other file permissions. Staged files use deterministic journal UUID names, exclusive creation, mode `0600`, fsync, checksums and authenticated round-trip verification. Plaintext is processed in memory only and buffers are cleared; the migration worker does not write plaintext temporary files.

**Activation remains intentionally disabled.** The worker is a library entrypoint only: it is not registered as a scheduler, API route, application startup task, or executable CLI. Importing it does not run a migration; there is no `--apply` command. CI uses synthetic encrypted fixtures and disposable PostgreSQL only. No user recording, production storage, or live profile reference is modified by these tests.

Before any separately approved live execution, all of the following remain required: escrow and independently recover both legacy and target voice keys; verify coordinated encrypted PostgreSQL and private-media backups and complete an isolated restore drill; confirm persistent storage and backup consistency; pause uploads, replacements, moderation transitions and purge workers for the maintenance window; run the complete procedure against synthetic fixtures; review journal events, reference changes, rollback and purge outcomes; define operational ownership, alerting and a controlled operator entrypoint. Keep the legacy ciphertext and key until the rollback window is formally closed and dependent backups/recovery procedures are verified. Passing CI does not satisfy these deployment gates.

The read-only inventory and V1-to-V2 migration preflight described above remain prerequisites for planning. They do not start the worker, authorize migration, or modify files or database rows. Never connect the worker to live data or schedule it without separate explicit approval.


## Recovery reconciliation gate: deletions and consent withdrawals

A successful PostgreSQL/media restore is not safe to expose merely because both archives decrypt and their checksums match. Restoring a snapshot from before a later account deletion or consent withdrawal can reintroduce an active account, profile/photo metadata, an earlier voice-consent grant, or references to private media that the user subsequently asked to erase.

The in-database purge queues and tombstones are part of the database snapshot. They do not contain deletion or withdrawal events that occurred after that snapshot was taken. A coordinated database/media backup window prevents a mismatched pair of snapshots; it does not prevent an older, otherwise valid recovery point from rolling back later privacy actions.

**Hard gate:** keep every restored environment isolated and unavailable to users until all deletion, media-removal and consent-withdrawal events newer than the restored database recovery point have been replayed and verified. Do not mount restored private media into an application-serving volume, enable discovery/playback, or permit account access before this gate is satisfied.

The repository currently has no independent, off-host, append-only erasure/consent event ledger and no configured PostgreSQL WAL/PITR recovery pipeline that proves those later events are replayed. The purge queues, account tombstones, consent history and this runbook warning are not substitutes for that independent recovery source. Therefore a restore from an older snapshot cannot currently prove that post-snapshot deletions or consent withdrawals will remain effective.

Before Production, implement and test one authoritative recovery mechanism:
- Preserve an independently durable, access-restricted, append-only sequence of account-erasure, private-media deletion and consent-withdrawal events outside the PostgreSQL backup failure domain, or configure PostgreSQL PITR/WAL archiving with a verified recovery point that includes those transactions.
- Bind each backup set to a recorded database recovery timestamp/LSN and the corresponding media snapshot/version identifiers.
- On restore, determine the event/WAL range after that recovery point, replay the privacy actions idempotently against the isolated staging database and restored media, and verify that deleted accounts remain non-discoverable, withdrawn-consent media remains unavailable, and all required physical purges are completed or durably queued.
- Fail closed if the event source, recovery watermark, media snapshot identity, or replay verification is unavailable or incomplete. Keep the restored environment isolated; do not silently treat missing evidence as an empty deletion backlog.
- Add integration tests that restore a pre-deletion snapshot, replay a later synthetic deletion and consent withdrawal, and prove that the account/media cannot become visible or playable. Also test interrupted replay and safe idempotent retry.

Until this mechanism exists and passes its isolated restore drill, encrypted backup integrity and archive round-trip tests are necessary but not sufficient for a Production recovery claim. No live account data should be used in these tests.


## Off-host privacy recovery ledger design

The selected implementation design and event contract are documented in [PRIVACY_RECOVERY_LEDGER.md](./PRIVACY_RECOVERY_LEDGER.md). The proposed Cloudflare Worker + D1 ledger is not provisioned or active. It must be deployed and integrated before Production; this remains a hard recovery gate. The design explicitly treats remote ledger acknowledgement as a prerequisite to committing privacy erasure/withdrawal state and requires an independently exported copy before claiming provider-independent disaster recovery.


## Private-media restore archive member safety

The automated `scripts/restore-private-media.sh` wrapper now performs a streaming preflight of the authenticated decrypted tar archive before creating the staging directory or extracting any member. The preflight uses Python's standard-library tar reader and accepts only regular files and directories. It rejects absolute paths, parent-directory traversal, duplicate normalized paths, file/directory path conflicts, symlinks, hardlinks, devices, FIFOs and other special entries. The archive is decrypted a second time for extraction only after the preflight succeeds; neither pass writes a plaintext archive to disk.

This policy matches the private-media backup contract: the media volume is expected to contain only regular files and directories. Do not weaken the restore filter to accommodate links or special files. If the application later requires another object type, design and test an explicit safe representation rather than restoring arbitrary tar link metadata.

Regression tests cover symlink and hardlink members, parent traversal, checksum mismatch, interrupted decryption, existing/symlink destinations, and cleanup of partial staging output. A restore is still restricted to an isolated new directory and must pass deletion/consent reconciliation before the data is mounted or exposed.


## Coordinated PostgreSQL + private-media backup bundles

Use the bundle wrapper when a database snapshot and its private-media archive must be retained and restored as one named recovery point. It invokes the existing encrypted streaming backup scripts with one shared snapshot ID, then writes a manifest that binds both archive paths and SHA-256 digests. Existing standalone backup commands remain supported.

Create a bundle from a trusted backup runner:

```bash
DATABASE_URL='postgresql://backup_role@db-host/vow_app' \
PRIVATE_MEDIA_DIR=/srv/vow/private-media \
BACKUP_AGE_RECIPIENT='age1...' \
BACKUP_DIR=/secure/backups/vow-bundles \
npm run backup:bundle
```

The wrapper creates a new private directory per snapshot and refuses to overwrite an existing ID. If either backup fails, it removes the incomplete bundle directory. Keep the complete directory (both encrypted archives, their checksum sidecars, and `manifest.txt` plus `manifest.sha256`) together in off-site storage. The manifest correlates the archives; it does not make the two source reads transactionally simultaneous or replace a database/media quiescence window and recorded recovery point.

Restore both artifacts into isolated targets:

```bash
BACKUP_BUNDLE_DIR=/secure/backups/vow-bundles/<snapshot-id> \
AGE_IDENTITY_FILE=/secure/escrow/vow-age-identity.txt \
RESTORE_DATABASE_URL='postgresql://restore_role@db-host/vow_restore_dst_example' \
RESTORE_CONFIRM_STAGING=I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE \
RESTORE_DESTINATION=/srv/vow/restore-staging/private-media \
npm run restore:bundle
```

The restore wrapper verifies the manifest and both archive digests before invoking the existing PostgreSQL and media restore guards. If one restore succeeds and the other fails, keep the successful target isolated and reconcile it manually; the wrapper never drops a database or deletes a partially restored target. The media directory receives `.vow-restore-pending` and must not be activated until the privacy-ledger replay and verification gate is satisfied. The integration test uses disposable PostgreSQL databases, synthetic files, and a temporary age identity; it does not access live user data or activate a backup schedule.


## Transactional privacy recovery Ledger outbox

Every API-side privacy recovery event is now inserted into `privacy_recovery_ledger_outbox` using the same PostgreSQL transaction as the domain mutation. The row contains only the stable event UUID and pseudonymized event payload; raw user/resource identifiers are not copied into the delivery queue. A transaction rollback therefore removes both the domain change and its pending Ledger event.

Run the one-shot delivery worker from a trusted private scheduler after migration 240 has been applied:

```bash
npm run privacy-ledger:outbox-worker
```

Schedule it at a short interval (for example, once per minute) with a deployment service manager or private cron runner. Do not expose the worker as a public HTTP endpoint. It claims work with `FOR UPDATE SKIP LOCKED`, a per-claim lease token and bounded lease expiry; retries always send the original event UUID and payload. Ledger acceptance is recorded only after a valid durable acknowledgement with a positive sequence number. Failed events use bounded exponential backoff and move to `dead` after 12 attempts; alert on any dead row or sustained pending backlog. The worker is not scheduled or enabled by this repository change.

Read-only queue checks:

```sql
SELECT status, count(*) AS events, min(created_at) AS oldest_created_at,
       max(attempts) AS max_attempts
FROM privacy_recovery_ledger_outbox
GROUP BY status
ORDER BY status;
```

Before enabling production recovery, configure the Ledger URL, HMAC secret and pseudonym key in the deployment secret manager, apply migrations, run the worker against a staging Ledger, and test rollback, retry, duplicate delivery, lease expiry and dead-letter alerting.
