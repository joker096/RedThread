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
export RESTORE_DOCKER_ENDPOINT=unix:///var/lib/vow-restore-audit01/docker.sock
export RESTORE_DOCKER_DAEMON_ID=<expected-hex-daemon-id>
export PRIVACY_RECOVERY_MEDIA_VOLUMES=vow-restore-audit01_private_photos,vow-restore-audit01_private_voice_intros,vow-restore-audit01_private_identity_l3
export HOST_WRITER_ISOLATION_GATE_EXECUTABLE=/absolute/path/to/host-writer-isolation-gate
# Pre-create this file with ownership/permissions restricted to the restore operator
groupadd --system vow-privacy-writers
export PRIVACY_RECOVERY_WRITER_GID="$(getent group vow-privacy-writers | cut -d: -f3)"
install -d -o root -g "$PRIVACY_RECOVERY_WRITER_GID" -m 2750 /var/lib/vow-restore-audit01
install -o root -g "$PRIVACY_RECOVERY_WRITER_GID" -m 0640 /dev/null /var/lib/vow-restore-audit01/writers.lock
export PRIVACY_RECOVERY_WRITER_LOCK_FILE=/var/lib/vow-restore-audit01/writers.lock
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
4. Mount the photo, voice-intro, and encrypted L3 roots plus a separate, empty L3 scratch root (`IDENTITY_L3_TEMP_DIR`) into the verifier's own mount namespace as read-only. The scratch root must be disjoint from encrypted L3 storage. The CLI reads `/proc/self/mountinfo` and rejects a missing or writable covering mount for any of the four roots.
5. Pre-create a root-owned, dedicated-group lock directory (mode `2750`) and lock file (mode `0640`) on a trusted local filesystem. Set the numeric `PRIVACY_RECOVERY_WRITER_GID` and provide an executable `PRIVACY_RECOVERY_DRAIN_EXECUTABLE`. The writer opens FD 9 read-only and takes a shared lock as an unprivileged group member; root maintenance opens it read/write and takes the exclusive lock. Activation closes admission with a durable root-owned group-visible sticky marker, drains admitted writers, then retains the exclusive lock through reconciliation and bind activation. This is cooperative coordination, not host isolation.
6. Before running the verifier, invoke the writer-isolation gate. Its Docker portion stops every service in the dedicated restore project except the isolated DB and rejects any running container anywhere on the daemon with a writable attachment to the restore media volumes. The gate must additionally prove host-level isolation for processes outside Docker, alternate namespaces, writable file descriptors and aliases; otherwise activation is blocked.
7. Keep all four roots read-only after verification. Do not remount them writable or attach them to a writable service until a separately reviewed activation procedure authorizes it.

## What the verifier proves

- It is connected to the explicitly named restore database using the explicitly named least-privilege login role.
- The role has no detected direct or inherited relation/sequence write privileges, schema/database CREATE privileges, or role memberships.
- The photo, voice-intro, and encrypted L3 media roots plus the separate L3 plaintext scratch root (`IDENTITY_L3_TEMP_DIR`) are covered by read-only mounts in the verifier process's current mount namespace. The L3 scratch root must be empty; any remaining entry blocks verification.
- The database snapshot, recovery ledger, replay receipts, purge obligations/completions, operational queues, and physical object absence checks pass.

## What it does not prove

A read-only mount inside one mount namespace does not prove that no other namespace, host process, container, open writable file descriptor, or storage replica can mutate the same underlying data. The mount check is deliberately scoped to the verifier's own namespace. Operator/orchestrator isolation remains mandatory and must be evidenced independently.

The Docker inventory is still subject to a time-of-check/time-of-use race unless the daemon is dedicated to the restore and its socket/admission controls prevent new writers during the full locked interval. The host gate must establish this independently; merely re-running `docker ps` is not sufficient.

The verifier does not prove erasure from snapshots, backups, replicas, filesystem journals, SSD remapping, or physical blocks. It verifies the configured directory entries and recovery database evidence only.

## Fail-closed behavior

The verifier exits before connecting to PostgreSQL if any encrypted media root or the L3 plaintext scratch root lacks read-only mount coverage. It also fails if the L3 scratch root contains any entry, including abandoned `.decrypt-*` plaintext staging files. It also rejects a restore database role with elevated attributes, role memberships, relation/sequence write privileges, or schema/database CREATE privileges. Do not weaken these checks to make a restore pass; correct the isolated restore environment instead.


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


## Cooperative writer admission integrated into the application stack

The cross-UID admission protocol is now integrated into the supported Compose/API launch paths in this branch. It is a cooperative control for processes that use the configured lock; it is not a kernel-enforced freeze and does not replace the independent host-level isolation gate below.

### Lock and marker protocol

`scripts/privacy-recovery-admission.sh` provides two modes:

- A writer runs unprivileged, validates the configured numeric GID and root-owned lock contract, opens FD 9 read-only, verifies the descriptor matches the configured lock inode, acquires a shared `flock`, checks the adjacent `.maintenance` marker while holding the lock, then execs the workload while retaining FD 9.
- Maintenance runs as root, opens FD 9 read/write, validates the same lock inode, creates and syncs the root-owned group-visible `.maintenance` marker before draining admitted writers, then acquires the exclusive lock and retains it through the critical command.
- The marker is intentionally sticky. Drain failure, lock timeout, process termination, or reboot does not reopen admission. There is no automatic marker removal or automatic writer reopening path.

The persistent host directory must be on a non-volatile filesystem (the normal host runbook uses `/var/lib/vow-privacy-admission`, not `/run`). The directory is root-owned by the dedicated writer group with mode `2750`; the lock file is root-owned by that group with mode `0640`. The configured GID must be explicitly provisioned and passed to every participating service.

### Compose and Node entrypoint integration

The API image now has a mandatory Dockerfile entrypoint through `scripts/privacy-recovery-admission.sh writer --`. It starts as the unprivileged `node` user and preserves FD 9 when it executes the configured command. The JavaScript guard in `server/privacyRecoveryAdmissionGuard.js` independently requires the inherited shared lock and rejects a missing/wrong descriptor, an unpinned lock path, or a present maintenance marker whenever `NODE_ENV=production` or `PRIVACY_RECOVERY_REQUIRE_ADMISSION=true`.

Compose mounts the pre-provisioned lock directory read-only at `/run/vow-privacy`, adds the configured numeric supplementary GID, and refuses to create a missing host source path. The host source directory must remain persistent even though its in-container mount point is under `/run`.

The audited Compose services covered by the shared admission mount and group are:

- `migrate`
- `ad-event-retention`
- `female-profile-exposure-retention`
- `account-reuse-retention`
- `gift-request-expiry`
- `identity-l3-worker`
- `identity-l3-purge-worker`
- `identity-l3-expiry`
- `private-photo-purge`
- `private-voice-intro-purge`
- `voice-intro-migration`
- `api`

The corresponding database-mutating Node entrypoints also call the JavaScript admission guard. The Nginx gateway and PostgreSQL server are not application-side DB-writing Node services and are not wrapped as such. The backup package entrypoints use the shared writer lock as readers and retain it for the full backup operation.

Coverage includes `scripts/compose-network-policy.test.js`, the admission helper and guard tests, and the CI Docker runtime smoke test. The smoke test verifies normal image admission, rejects direct Node launch without inherited FD 9, and verifies that a maintenance marker closes writer admission.

### Residual bypass boundary

This integration protects the supported Compose launch paths, ordinary restarts, and guarded Node entrypoints when the configured host lock is provisioned correctly. It is not a security boundary against a privileged host administrator or Docker daemon administrator: such an administrator can override an entrypoint, change mounts/environment, or launch a process outside the cooperative protocol. Restrict Docker socket/context access to trusted operators.

Manual/host-managed production Node services must use the same persistent lock inode, configured GID, and `privacy-recovery-admission.sh writer -- ...` launcher. A direct Node/npm invocation without a valid inherited FD 9 is rejected by the production guard. Do not create a second lock file for a worker or backup process; all participants must use the same inode and marker path.

## Restore-only writer isolation gate: separate mandatory prerequisite

The cooperative application admission protocol does not prove that every process with access to restored media participates in it. Real private-media restore activation remains prohibited until the independent host-level isolation gate is implemented, tested, and its evidence reviewed.

The supplied `scripts/privacy-recovery-stop-writers.sh` is only the Docker portion of the restore gate. It:

- Requires a dedicated `vow-restore-*` Compose project, an explicitly pinned non-default Docker context, endpoint, and daemon ID.
- Stops every service in that restore project except its dedicated database.
- Inspects all running containers on the pinned daemon and rejects writable attachments to the three exact restore media volumes.
- Requires an operator-supplied `HOST_WRITER_ISOLATION_GATE_EXECUTABLE` and invokes it through a pinned, verified file descriptor.
- Never stops unrelated containers automatically.

The external host gate is not a placeholder that may simply return zero. It must independently prove the caller's inherited exclusive lock, enforce admission closure for the full critical interval, inspect processes and mount namespaces, identify open writable descriptors and bind aliases, cover host/container runtime launch paths, and produce machine-readable timestamped evidence. It must fail closed on inaccessible process/namespace data, uncertain storage identity, an unpinned Docker daemon, or any writer that can bypass admission.

The current repository does not implement a universal host process inspector or the complete host-wide admission enforcement/evidence system. A Docker container scan alone is subject to a time-of-check/time-of-use race and cannot establish host isolation. If the external host gate is missing, incomplete, or unverified, the operator must keep the restore pending and must not activate it.

### Required host-gate acceptance tests

Before accepting the external gate, test that it rejects at least:

- A missing, replaced, or mismatched inherited lock descriptor.
- A second writer admission during the critical interval.
- A writer in a separate mount/PID namespace.
- A bind-mount alias or writable alias to any protected media volume.
- An open writable descriptor to a deleted file.
- An inaccessible or changing `/proc` entry and a process appearing during the scan.
- An unexpected Docker endpoint/daemon ID or a new container admitted after initial enumeration.
- Any unsupported runtime or storage access path that cannot be independently inspected.

Tests must demonstrate that admission remains closed until the activation wrapper releases its lock, including gate failure and signal/termination paths. Evidence must identify the host, gate version/hash, lock device/inode and descriptor, admission policy and held state, Docker endpoint/daemon identity, process/namespace scan coverage, protected storage identities, and each explicit pass/fail result. Do not include media contents or personal data.

### Restore lock path example

Use a persistent host path for the restore lock as well; do not put the host lock/marker directory under volatile `/run`:

```sh
export PRIVACY_RECOVERY_WRITER_GID='<numeric-writer-group-id>'
export PRIVACY_RECOVERY_WRITER_LOCK_FILE=/var/lib/vow-restore-audit01/writers.lock
install -d -o root -g "$PRIVACY_RECOVERY_WRITER_GID" -m 2750 /var/lib/vow-restore-audit01
install -o root -g "$PRIVACY_RECOVERY_WRITER_GID" -m 0640 /dev/null "$PRIVACY_RECOVERY_WRITER_LOCK_FILE"
```

The lock directory may be bind-mounted read-only inside containers at `/run/vow-privacy`; the host source remains persistent. The marker is adjacent to the lock file and must survive a reboot.

## Private-media backup admission integration

The private-media backup is a reader of the protected source tree. It now runs through the cooperative writer-admission helper (shared lock) and retains inherited FD 9 for the full archive, encryption, checksum and retention operation. The backup script independently verifies on Linux that FD 9 resolves to the configured lock path and carries a live shared flock; direct invocation without the admitted descriptor fails closed. It also rejects the sticky maintenance marker. The package command `npm run backup:private-media` invokes the admission helper, so the supported package entrypoint no longer bypasses the cooperative lock.

This closes the backup command's cooperative admission path using the root-owned cross-UID lock contract. The API and all 12 audited Compose database-writing services are also integrated with the same admission lock and guarded Node entrypoints, as described above. These controls cover supported launch paths but cannot force a privileged host/root or Docker administrator to participate, and they do not implement the independent host-level writer-isolation gate. Do not treat cooperative admission alone as proof that restore activation is safe. Until the external host gate and its evidence are implemented, tested and reviewed, real private-media restore activation remains blocked.
