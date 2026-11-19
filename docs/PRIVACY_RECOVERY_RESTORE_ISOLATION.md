# Private media restore isolation contract

This runbook applies only to a disposable, isolated restore target. It is not a production deployment procedure.

## Required isolation before verification

1. Restore PostgreSQL into a dedicated database whose name matches `vow_restore_<suffix>`.
2. Connect with a dedicated login role whose name matches `vow_restore_<suffix>`. Do not reuse the API, migration, owner, or administrator role.
3. The restore role must have no role memberships, no superuser/createdb/createrole/replication/bypass-RLS attributes, no write privileges on user relations or sequences, and no CREATE privilege on user schemas or the database. The verifier checks these properties at runtime.
4. Mount each restored media root into the verifier's own mount namespace as read-only. The CLI reads `/proc/self/mountinfo` and rejects a missing or writable covering mount for photo, voice-intro, or L3 storage.
5. Before running the verifier, stop every process that can write to the restored data outside the verifier namespace: API instances, photo/voice/L3 purge workers, upload handlers, migration workers, backup/restore jobs, and any host process with a writable alias to the same storage.
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
