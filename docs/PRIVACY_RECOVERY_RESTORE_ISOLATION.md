# Private media restore isolation contract

This runbook applies only to a disposable, isolated restore target. It is not a production deployment procedure.

## Required isolation before verification

The activation wrapper now requires a pre-created `PRIVACY_RECOVERY_WRITER_LOCK_FILE` and holds its non-blocking `flock` lock from before writer isolation through domain reconciliation and bind activation. The lock file must be an absolute regular non-symlink file. The wrapper exports its path and descriptor (`PRIVACY_RECOVERY_WRITER_LOCK_FD=9`) to the gates. Every process manager, container launcher, scheduled job, and operator action capable of starting a media writer must participate in the same admission lock; otherwise the lock alone does not prevent a non-cooperating writer from starting.

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
5. Pre-create a root-owned, mode-0600 lock file on a trusted local filesystem. Ensure all writer-launch paths use the same lock/admission policy. The activation wrapper holds this lock continuously across the writer gate, domain reconciliation, and bind mount. The lock is cooperative and does not itself block uncooperative privileged processes.
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
