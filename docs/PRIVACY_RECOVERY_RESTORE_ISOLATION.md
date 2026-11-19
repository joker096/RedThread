# Private media restore isolation contract

This runbook applies only to a disposable, isolated restore target. It is not a production deployment procedure.

## Required isolation before verification

The activation wrapper now requires two independent executables:
- `PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE`: a fail-closed writer isolation gate.
- `PRIVACY_RECOVERY_GATE_EXECUTABLE`: the existing domain-specific inventory/replay/receipt/queue/consent reconciliation gate.

The supplied `scripts/privacy-recovery-stop-writers.sh` is the Docker portion of the first gate. Run it only against a dedicated restore Compose project named `vow-restore-*`, never the normal Vow Compose project. It stops every service in that project except its dedicated `db`, then inspects every running container on the Docker daemon and rejects writable attachments to the three exact project-scoped media volumes. It requires Docker Compose, `jq`, and `HOST_WRITER_ISOLATION_GATE_EXECUTABLE`: an absolute executable supplied by the restore operator that independently verifies host processes, alternate mount namespaces, open writable descriptors, bind-mount aliases and other host storage access paths. The Docker script invokes this host gate and fails closed if it is absent or returns non-zero. It refuses to stop unrelated containers automatically.

Example environment for the Docker gate (replace the project suffix and Compose file with the disposable restore instance):
```sh
export RESTORE_COMPOSE_PROJECT=vow-restore-audit01
export RESTORE_COMPOSE_FILE=/absolute/path/to/restore-compose.yaml
export PRIVACY_RECOVERY_MEDIA_VOLUMES=vow-restore-audit01_private_photos,vow-restore-audit01_private_voice_intros,vow-restore-audit01_private_identity_l3
export HOST_WRITER_ISOLATION_GATE_EXECUTABLE=/absolute/path/to/host-writer-isolation-gate
scripts/privacy-recovery-stop-writers.sh
```

The host-level executable is an independent, operator-supplied control; this repository does not pretend to implement a universal host process inspector. If a trustworthy host-level check is unavailable, the Docker gate fails closed because its required executable is absent, and the operator must keep the restore pending and must not activate it.

1. Restore PostgreSQL into a dedicated database whose name matches `vow_restore_<suffix>`.
2. Connect with a dedicated login role whose name matches `vow_restore_<suffix>`. Do not reuse the API, migration, owner, or administrator role.
3. The restore role must have no role memberships, no superuser/createdb/createrole/replication/bypass-RLS attributes, no write privileges on user relations or sequences, and no CREATE privilege on user schemas or the database. The verifier checks these properties at runtime.
4. Mount each restored media root into the verifier's own mount namespace as read-only. The CLI reads `/proc/self/mountinfo` and rejects a missing or writable covering mount for photo, voice-intro, or L3 storage.
5. Before running the verifier, invoke the writer-isolation gate. Its Docker portion stops every service in the dedicated restore project except the isolated DB and rejects any running container anywhere on the daemon with a writable attachment to the restore media volumes. The gate must additionally prove host-level isolation for processes outside Docker, alternate namespaces, writable file descriptors and aliases; otherwise activation is blocked.
6. Keep the restored media roots read-only after verification. Do not remount them writable or attach them to a writable service until a separately reviewed activation procedure authorizes it.

## What the verifier proves

- It is connected to the explicitly named restore database using the explicitly named least-privilege login role.
- The role has no detected direct or inherited relation/sequence write privileges, schema/database CREATE privileges, or role memberships.
- All three configured media roots are covered by read-only mounts in the verifier process's current mount namespace.
- The database snapshot, recovery ledger, replay receipts, purge obligations/completions, operational queues, and physical object absence checks pass.

## What it does not prove

A read-only mount inside one mount namespace does not prove that no other namespace, host process, container, open writable file descriptor, or storage replica can mutate the same underlying data. The mount check is deliberately scoped to the verifier's own namespace. Operator/orchestrator isolation remains mandatory and must be evidenced independently.

The verifier does not prove erasure from snapshots, backups, replicas, filesystem journals, SSD remapping, or physical blocks. It verifies the configured directory entries and recovery database evidence only.

## Fail-closed behavior

The verifier exits before connecting to PostgreSQL if any media root lacks read-only mount coverage. It also rejects a restore database role with elevated attributes, role memberships, relation/sequence write privileges, or schema/database CREATE privileges. Do not weaken these checks to make a restore pass; correct the isolated restore environment instead.
