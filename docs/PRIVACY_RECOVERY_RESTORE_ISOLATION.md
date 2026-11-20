# Private media restore isolation contract

This runbook applies only to a disposable, isolated restore target. It is not a production deployment procedure.

## Required isolation before verification

The activation wrapper requires a pre-created `PRIVACY_RECOVERY_WRITER_LOCK_FILE` and now invokes `scripts/privacy-recovery-admission.sh maintenance` before entering its internal activation phase. The helper creates and syncs the adjacent sticky `.maintenance` marker, invokes `PRIVACY_RECOVERY_DRAIN_EXECUTABLE`, then acquires the exclusive `flock`; FD 9 is inherited by the activation phase and held through writer isolation, domain reconciliation, and bind activation. The activation phase refuses to proceed without the inherited descriptor, the marker, and evidence that the lock is unavailable to a competing exclusive locker. Cheap path/marker/mountpoint validation runs before admission is closed. The marker is deliberately not removed on success or failure: reopening requires a separately reviewed, audited procedure. This fixes the activation-order deadlock for participants that honor the helper, but it does not itself stop non-cooperating writers. Every process manager, container launcher, scheduled job, and operator action capable of starting a media writer must participate in the same admission policy; host-level enforcement remains mandatory.

The activation wrapper also requires two independent executables:
- `PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE`: a fail-closed writer isolation gate.
- `PRIVACY_RECOVERY_GATE_EXECUTABLE`: the existing domain-specific inventory/replay/receipt/queue/consent reconciliation gate.

The supplied `scripts/privacy-recovery-stop-writers.sh` is the Docker portion of the first gate. Run it only against a dedicated restore Compose project named `vow-restore-*`, never the normal Vow Compose project. It stops every service in that project except its dedicated `db`, then inspects every running container on the Docker daemon and rejects writable attachments to the three exact project-scoped media volumes. It requires Docker Compose, `jq`, and `HOST_WRITER_ISOLATION_GATE_EXECUTABLE`: an absolute executable supplied by the restore operator that independently verifies host processes, alternate mount namespaces, open writable descriptors, bind-mount aliases and other host storage access paths. The Docker script invokes this host gate and fails closed if it is absent or returns non-zero. It refuses to stop unrelated containers automatically.

Example environment for the Docker gate (replace the project suffix and Compose file with the disposable restore instance):
```sh
export RESTORE_COMPOSE_PROJECT=vow-restore-audit01
export RESTORE_COMPOSE_FILE=/absolute/path/to/restore-compose.yaml
# Provision and pin a dedicated, restore-only Docker context and daemon.
export RESTORE_DOCKER_CONTEXT=vow-restore-audit01
export RESTORE_DOCKER_ENDPOINT=unix:///run/vow-restore-audit01/docker.sock
export RESTORE_DOCKER_DAEMON_ID=<expected-hex-daemon-id>
export PRIVACY_RECOVERY_MEDIA_VOLUMES=vow-restore-audit01_private_photos,vow-restore-audit01_private_voice_intros,vow-restore-audit01_private_identity_l3
export HOST_WRITER_ISOLATION_GATE_EXECUTABLE=/absolute/path/to/host-writer-isolation-gate
# Pre-create this file with ownership/permissions restricted to the restore operator
install -d -o root -g root -m 0700 /run/vow-restore-audit01
install -o root -g root -m 0600 /dev/null /run/vow-restore-audit01/writers.lock
export PRIVACY_RECOVERY_WRITER_LOCK_FILE=/run/vow-restore-audit01/writers.lock
# Must drain all admitted writers in this isolated restore environment.
export PRIVACY_RECOVERY_DRAIN_EXECUTABLE=/absolute/path/to/restore-writer-drain-controller
export PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE=/absolute/path/to/scripts/privacy-recovery-stop-writers.sh
export PRIVACY_RECOVERY_GATE_EXECUTABLE=/absolute/path/to/domain-reconciliation-gate
export RESTORE_DESTINATION=/absolute/path/to/disposable-restore-staging
export PRIVATE_MEDIA_MOUNTPOINT=/absolute/path/to/empty-private-media-mountpoint
bash scripts/activate-private-media-restore.sh
```



The Docker gate now requires all three pinning values above. It rejects the default Docker context, clears ambient `DOCKER_HOST`, checks the selected context's configured endpoint, and checks the connected daemon's `docker info` ID before issuing any Compose, list, or inspect command. The expected daemon ID must be a 12–64 character hexadecimal value obtained during trusted restore-host provisioning. The endpoint and daemon ID are identity pins, not proof of exclusivity: the host gate must still prove that the daemon/socket is dedicated and that no other principal can admit workloads during the critical section. A context name or socket path alone is not a security boundary.

The host-level executable is an independent, operator-supplied control; this repository does not pretend to implement a universal host process inspector. It must verify the inherited lock descriptor and the external admission policy, and must fail if any writer-launch path can bypass the lock. The `flock` only coordinates participants that honor it; it is not a kernel-enforced freeze and does not stop arbitrary root processes. A dedicated restore-only Docker daemon/socket and an independently enforced writer-admission policy are still required to close the Docker enumeration race. If these controls cannot be evidenced, the operator must keep the restore pending and must not activate it.

1. Restore PostgreSQL into a dedicated database whose name matches `vow_restore_<suffix>`.
2. Connect with a dedicated login role whose name matches `vow_restore_<suffix>`. Do not reuse the API, migration, owner, or administrator role.
3. The restore role must have no role memberships, no superuser/createdb/createrole/replication/bypass-RLS attributes, no write privileges on user relations or sequences, and no CREATE privilege on user schemas or the database. The verifier checks these properties at runtime.
4. Mount each restored media root into the verifier's own mount namespace as read-only. The CLI reads `/proc/self/mountinfo` and rejects a missing or writable covering mount for photo, voice-intro, or L3 storage.
5. Pre-create a root-owned, mode-0600 lock file on a trusted local filesystem and provide an executable `PRIVACY_RECOVERY_DRAIN_EXECUTABLE`. Activation closes admission with a durable sticky marker, drains already-admitted writers, then acquires the exclusive lock and retains it through reconciliation and bind activation. The lock is cooperative and does not itself block uncooperative privileged processes.
6. Before running the verifier, invoke the writer-isolation gate. Its Docker portion stops every service in the dedicated restore project except the isolated DB and rejects any running container anywhere on the daemon with a writable attachment to the restore media volumes. The gate must additionally prove host-level isolation for processes outside Docker, alternate namespaces, writable file descriptors and aliases; otherwise activation is blocked.
7. Keep the restored media roots read-only after verification. Do not remount them writable or attach them to a writable service until a separately reviewed activation procedure authorizes it.

## What the verifier proves

- It is connected to the explicitly named restore database using the explicitly named least-privilege login role.
- The role has no detected direct or inherited relation/sequence write privileges, schema/database CREATE privileges, or role memberships.
- All three configured media roots are covered by read-only mounts in the verifier process's current mount namespace.
- The database snapshot, recovery ledger, replay receipts, purge obligations/completions, operational queues, and physical object absence checks pass.

## What it does not prove

A read-only mount inside one mount namespace does not prove that no other namespace, host process, container, open writable file descriptor, or storage replica can mutate the same underlying data. The mount check is deliberately scoped to the verifier's own namespace. Operator/orchestrator isolation remains mandatory and must be evidenced independently.

The Docker inventory is still subject to a time-of-check/time-of-use race unless the daemon is dedicated to the restore and its socket/admission controls prevent new writers during the full locked interval. The host gate must establish this independently; merely re-running `docker ps` is not sufficient.

The verifier does not prove erasure from snapshots, backups, replicas, filesystem journals, SSD remapping, or physical blocks. It verifies the configured directory entries and recovery database evidence only.

## Fail-closed behavior

The verifier exits before connecting to PostgreSQL if any media root lacks read-only mount coverage. It also rejects a restore database role with elevated attributes, role memberships, relation/sequence write privileges, or schema/database CREATE privileges. Do not weaken these checks to make a restore pass; correct the isolated restore environment instead.


## Host writer-isolation gate: mandatory acceptance contract

The external `HOST_WRITER_ISOLATION_GATE_EXECUTABLE` is not a placeholder that may simply return zero. It is a security boundary. Until an implementation satisfies every item below and its evidence is reviewed, the restore activation wrapper must not be run against real data.

### 1. Caller lock continuity

- Require `PRIVACY_RECOVERY_WRITER_LOCK_FILE` and a numeric `PRIVACY_RECOVERY_WRITER_LOCK_FD`.
- Verify that `/proc/self/fd/$PRIVACY_RECOVERY_WRITER_LOCK_FD` resolves to the same device/inode as the configured lock file. Reject missing, closed, replaced, symlink-substituted, or mismatched descriptors.
- The descriptor must be inherited from the activation wrapper, which acquired the non-blocking exclusive `flock`. Do not open a second descriptor and assume it represents the caller's lock.
- Keep the caller's lock descriptor open until the wrapper has completed reconciliation and bind activation. The host gate must not release, replace, or downgrade it.

### 2. Admission control, not just process discovery

- Prove that every supported writer launch path is mediated by the same admission policy: systemd units, Docker/container runtime, Compose operators, scheduled jobs, queue workers, maintenance scripts, and administrative tooling.
- The policy must reject new writer admissions for the entire interval from before the host scan until the wrapper exits its critical section. A one-time scan followed by returning success is insufficient.
- Prove that no unmediated writer path remains for the protected storage. A cooperative `flock` is not sufficient unless every launch authority is forced through it.
- Define the threat boundary explicitly. A privileged host administrator/root compromise can bypass local controls and cannot be proven absent by a shell script; if the threat model includes hostile root, use a separately controlled restore host or VM and keep the restore blocked on a shared host.

### 3. Process, namespace, descriptor and storage coverage

- Enumerate processes using stable process identity (PID plus start time or pidfd) to avoid PID-reuse races. Fail closed when required `/proc` data is hidden, inaccessible, or changes during inspection.
- Inspect every relevant mount namespace, not only the gate's namespace. Resolve mount sources and device/inode identity so bind-mount aliases and alternate paths to the same underlying media are detected.
- Inspect open file descriptors and memory mappings for writable handles to protected media, including deleted-but-open files. A path-only `lsof`/ `fuser` result is not sufficient evidence.
- Account for processes outside the current PID namespace, containers, runtime shims, and host services. If the gate cannot see a namespace or descriptor table, it must fail closed.
- Verify that the protected source and restore target are not writable through another block-device, network-filesystem, snapshot, or replica path during the critical interval.

### 4. Dedicated container runtime

- Require an explicitly configured restore-only Docker endpoint; reject the default shared daemon socket.
- Verify the endpoint is a dedicated daemon, not merely a socket with a restore-looking filename. Pin and check the expected daemon identity and verify that no unrelated workload can be scheduled there.
- Ensure the daemon's admission policy is held closed for the full wrapper critical section. Docker enumeration alone is subject to a race and cannot satisfy this requirement.
- Verify every protected volume by stable volume identity and backing device/inode, not only by Compose volume name. Reject writable volume mounts and writable bind aliases.

### 5. Evidence and failure handling

The gate must produce a machine-readable, timestamped evidence record containing the host identity, gate version/hash, lock device/inode and descriptor number, admission-policy identity and held state, Docker endpoint and daemon identity, process/namespace scan coverage, protected storage identities, and explicit pass/fail results for each check. Do not include private media contents or personal data in this record.

Any missing capability, permission error, unsupported namespace/runtime, policy uncertainty, stale evidence, or non-zero subcheck must produce a non-zero exit and leave `.vow-restore-pending` untouched. Evidence must be retained with the restore audit record. A successful process scan without enforced admission control is a failure, not a warning.

### 6. Required tests before this gate can be accepted

At minimum, test that the gate rejects: a missing or replaced inherited lock descriptor; a second writer admission during the critical interval; a writer in a separate mount/PID namespace; a bind-mount alias; an open writable descriptor to a deleted file; an inaccessible `/proc` entry; a process appearing during the scan; an unexpected Docker daemon ID/socket; a new container admitted after initial enumeration; and a writable alias to any protected volume. Tests must demonstrate that admission remains blocked until the activation wrapper releases its lock, including on gate failure and signal/termination paths.

The current repository does not yet contain this privileged host gate or these host-level integration tests. This contract is therefore an explicit unresolved prerequisite, not a claim that host-wide writer isolation has been implemented.


## Writer admission primitive (foundational; not yet wired into services)

`scripts/privacy-recovery-admission.sh` provides a small cooperative protocol for testing and later integration:

- A writer acquires a shared `flock`, checks the adjacent `.maintenance` marker while holding that lock, and then `exec`s its workload while retaining the descriptor.
- Maintenance atomically creates the marker directory first, fsyncs its parent, invokes a separately provisioned drain controller, and only then waits for the exclusive lock.
- The marker is intentionally sticky. Drain failure, lock timeout, process termination, or reboot does not reopen admission.
- If a writer checked for the marker before it was created, it is an already-admitted writer and must be stopped/drained before the exclusive lock can be acquired. If it checks after marker creation, it must reject startup.

The activation wrapper now invokes this primitive in `maintenance` mode. It is still **not mounted into Compose, used by the API entrypoint, or applied to purge/migration/manual launch paths**. It therefore does not protect running Vow services and must not be treated as satisfying the host writer-isolation gate. Integration with services requires a provisioned shared lock inode and marker path visible identically to host and every relevant container, an enforced launch policy that prevents bypass, a real drain controller, and the host-level attestation/evidence contract above.


## Activation ordering: marker-first protocol integrated

The activation wrapper now delegates admission sequencing to `scripts/privacy-recovery-admission.sh maintenance`. It performs non-mutating input/path/mountpoint validation first, then the helper creates and syncs the sticky maintenance marker, invokes the configured drain controller, waits for existing shared-lock writers to exit, and acquires the exclusive lock. The helper then execs the activation phase while retaining FD 9. The activation phase verifies the inherited descriptor and marker and does not reopen the lock.

The activation tests now exercise the real wrapper with an already-admitted long-running writer. They verify that the marker exists before drain, a new writer is rejected, activation waits for the old writer's shared lock to be released, and writer isolation/reconciliation/mount occur only after the exclusive lock is held.

The maintenance marker remains after successful activation and all failures. There is intentionally no automatic reopening path. A separate audited reopening procedure is still required before future writers can start.

This integration fixes the ordering mismatch in the activation wrapper for cooperative participants. It does **not** implement service-wide admission enforcement or host-level isolation. Compose/API/purge/migration/manual writer paths still need to be wired to the same lock and marker, and the independent host gate must still prove that non-cooperating host processes, namespaces, descriptors, aliases and Docker clients cannot write during the critical section. Until those controls and their evidence exist, real private-media restore activation remains prohibited.

## Host/container lock permissions: unresolved integration blocker

The current lock helper is intentionally **host-operator-only** and is not safe to mount into the API or worker containers as-is:

- The API image runs as the unprivileged `node` user.
- The helper currently requires the lock file owner to equal the calling UID, requires group/other permissions to be absent, and opens the lock read/write for every mode.
- The documented host provisioning example creates a root:root mode-0600 lock. A `node` process cannot open that file, and changing it to mode 0644/0666 or making it group-writable would weaken the security boundary rather than solve it.

Do not bind-mount the current host lock into Compose and do not claim that the services participate in admission until a dedicated cross-boundary contract is implemented and tested.

A candidate contract for review (not yet implemented or approved):

1. Provision a dedicated, non-login host group for Vow writer admission. Its numeric GID must be explicitly selected during host provisioning and passed as configuration; never assume that UID/GID 1000 or any image-default group is suitable.
2. The lock inode is host-owned by root and the dedicated group, with mode `0640`. Its parent directory is root-owned by the same group, mode `0750`, and not writable by group members. The sticky maintenance marker is created by the root maintenance process with the same group and mode `0750`; marker creation must remain durable and fail closed.
3. Every writer container receives the same host lock inode and marker parent through read-only bind mounts. Its process identity must have the configured dedicated supplementary GID (for Compose this must be explicitly provisioned, e.g. with `group_add`, and verified at runtime). No container receives write access to the lock or marker parent.
4. Writer mode opens the lock read-only and takes a shared `flock`; maintenance mode opens it read/write as root and takes the exclusive lock. Linux shared `flock` is supported on a read-only descriptor, but this exact behavior must be covered by tests in the target runtime/filesystem. The writer checks the marker while holding the shared lock and retains the descriptor for the entire writer lifetime.
5. The helper must validate the configured numeric GID, actual supplementary-group membership, root/group ownership, exact permission masks, canonical parent path, non-symlink inode identity, and marker type/ownership/mode. It must reject an unconfigured GID, an unexpected group, writable group/other bits, and a lock or marker mounted from a different inode.
6. Provisioning must create the lock and marker parent before any Vow writer can start. A boot-time service / systemd ordering dependency and a single mandatory entrypoint guard must prevent API, purge, migration, scheduled, restart-policy and manual Compose launches from bypassing admission. Read-only bind mounts alone do not enforce launch policy.
7. Tests must cover root maintenance versus node writer, shared lock on read-only FD, supplementary GID present/missing, wrong GID, group/world write rejection, marker visibility, marker creation durability, long-lived writer drain, descriptor inheritance, mount identity across every consumer, and attempted manual/restart startup during maintenance.

The candidate permissions above are a design direction only. Do not modify the current helper to accept group ownership or relax its permissions until the full provisioning, service integration, boot ordering, host admission policy, and tests are implemented together. The independent host-level isolation gate and its machine-readable attestation remain separate mandatory prerequisites.

## Compose writer inventory and admission bypasses

The Compose and package manifests at the audited revision show that admission is not yet wired into the real process launch paths.

### Processes with private-media access

| Service / command | Private storage access | Restart / launch characteristic |
|---|---|---|
| `api` / `npm run start:api` | Writable mounts for photos, voice introductions and L3 identity media | `unless-stopped`; Dockerfile CMD starts Node directly |
| `private-photo-purge` | Writable photo volume | `unless-stopped`; shell loop starts worker directly |
| `private-voice-intro-purge` | Writable voice-intro volume | `unless-stopped`; shell loop starts worker directly |
| `identity-l3-purge-worker` | Writable L3 volume | `unless-stopped`; direct Node command |
| `identity-l3-worker` | Read-only L3 volume | `unless-stopped`; direct Node command, still a private-media reader and must be drained/guarded during restore |
| `voice-intro-migration` | Writable voice-intro volume | One-shot profile; direct Node command |
| `backup:private-media` / `scripts/backup-private-media.sh` | Reads the complete active private-media root; writes an encrypted archive outside that root | Direct/manual package script; no shared admission lock |
| `migrate` | No private-media volume in current Compose definition | One-shot DB migration; must be considered for startup sequencing, but it is not currently a private-volume writer |

The following services also run periodic database maintenance commands, but do not mount the three private-media volumes in the inspected Compose definition: `ad-event-retention`, `female-profile-exposure-retention`, `account-reuse-retention`, `gift-request-expiry`, and `identity-l3-expiry`. Their database mutation lifecycle should be inventoried separately; do not conflate them with filesystem writers.

### Confirmed bypasses and protocol mismatch

- The API image sets `USER node` and launches `npm run start:api` directly from the Dockerfile. There is no common admission entrypoint.
- Compose commands for the photo purge, voice purge, L3 worker, L3 purge worker and voice-intro migration invoke Node or a shell loop directly. They do not acquire the admission lock.
- `restart: unless-stopped` means Docker can relaunch several consumers without the maintenance script being invoked. Stopping a Compose project and checking its current containers is not a durable launch barrier.
- Package scripts expose direct worker and API commands (including `start:api`, `identity:l3-worker`, `photos:purge`, `voice-intros:purge`, and `voice-intros:migrate-once`). Local/manual operator invocations therefore also bypass a container-only wrapper.
- `npm run backup:private-media` invokes `scripts/backup-private-media.sh` directly. The script reads the active private-media tree without taking a shared admission lock. Although it does not mutate the source tree, it can overlap restore/maintenance and is not covered by the current drain protocol.
- The current admission helper opens the lock with `exec 9<>` in both writer and maintenance modes. Writer mode therefore requires write access, contrary to the proposed read-only shared-lock contract. It also enforces caller ownership and private permissions, so it cannot yet support the proposed root-owned dedicated-group lock.
- The current helper is a cooperative primitive, not a mandatory guard. No Compose service, Dockerfile entrypoint, package command or boot-time unit shown in this inventory forces every relevant launch path through it.

### Integration rule

Do not wire only the API or only the purge workers. Once the cross-UID lock contract is implemented, every process that can read or write private-media roots must participate in the same lock protocol. This includes backup readers: a backup must acquire and retain the shared admission lock for the entire source snapshot/archive operation, then release it only after the read is complete. A backup reader must reject the sticky maintenance marker just like a media writer; otherwise maintenance can race an in-progress backup. For long-running processes, the shared lock descriptor must remain open for the entire period of access, not merely around startup. The writer must acquire the shared lock and check the sticky maintenance marker while holding it; on marker presence it must refuse to start. Maintenance must create and durably sync the marker before draining existing participants and acquiring the exclusive lock.

Before service integration, add tests for read-only shared-lock acquisition and verify the same host inode and marker directory from every relevant container. Then add one mandatory entrypoint/launcher for the API and every worker/migration profile, plus a host boot/start policy that prevents direct Compose/manual/restart launches from bypassing it. The Docker daemon/socket access boundary and external host-level isolation attestation remain independent prerequisites.


## Private-media backup admission integration

The private-media backup is a reader of the protected source tree. It now runs through the cooperative writer-admission helper (shared lock) and retains inherited FD 9 for the full archive, encryption, checksum and retention operation. The backup script independently verifies on Linux that FD 9 resolves to the configured lock path and carries a live shared flock; direct invocation without the admitted descriptor fails closed. It also rejects the sticky maintenance marker. The package command `npm run backup:private-media` invokes the admission helper, so the supported package entrypoint no longer bypasses the cooperative lock.

This closes only the backup command's cooperative admission path. It does not resolve the cross-UID/root-owned lock contract, force every host/manual launch authority through admission, integrate API and all workers, or implement the independent host-level writer-isolation gate. Do not treat backup admission alone as proof that restore activation is safe. Until the complete admission and host-isolation requirements above are satisfied, real private-media restore activation remains blocked.
