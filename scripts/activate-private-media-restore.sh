#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${RESTORE_DESTINATION:?Set RESTORE_DESTINATION to the isolated restore staging directory}"
: "${PRIVATE_MEDIA_MOUNTPOINT:?Set PRIVATE_MEDIA_MOUNTPOINT to an existing empty mountpoint}"
: "${PRIVACY_RECOVERY_GATE_EXECUTABLE:?Set PRIVACY_RECOVERY_GATE_EXECUTABLE to the executable domain-reconciliation gate}"
: "${PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE:?Set PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE to the Docker/host writer-isolation gate}"

: "${PRIVACY_RECOVERY_WRITER_LOCK_FILE:?Set a pre-created exclusive writer-admission lock file}"
command -v flock >/dev/null 2>&1 || { echo "flock is required for restore writer admission locking" >&2; exit 1; }
command -v realpath >/dev/null 2>&1 || { echo "realpath is required to validate the writer lock directory" >&2; exit 1; }
if [[ ! "$PRIVACY_RECOVERY_WRITER_LOCK_FILE" = /* ||
      ! -f "$PRIVACY_RECOVERY_WRITER_LOCK_FILE" ||
      -L "$PRIVACY_RECOVERY_WRITER_LOCK_FILE" ]]; then
  echo "writer-admission lock must be an absolute, pre-created regular non-symlink file" >&2
  exit 1
fi
lock_dir="$(dirname -- "$PRIVACY_RECOVERY_WRITER_LOCK_FILE")"
lock_name="$(basename -- "$PRIVACY_RECOVERY_WRITER_LOCK_FILE")"
canonical_lock_dir="$(realpath -e -- "$lock_dir")"
if [[ "$canonical_lock_dir" != "$lock_dir" || -L "$lock_dir" ]]; then
  echo "writer-admission lock directory must use its canonical, non-symlink path" >&2
  exit 1
fi
# Ownership, numeric GID, exact modes and read-only writer access are validated
# by the mandatory admission helper. Do not duplicate or weaken that contract here.
PRIVACY_RECOVERY_WRITER_LOCK_FILE="$canonical_lock_dir/$lock_name"

command -v mount >/dev/null 2>&1 || { echo "mount is required" >&2; exit 1; }
command -v mountpoint >/dev/null 2>&1 || { echo "mountpoint is required" >&2; exit 1; }
command -v umount >/dev/null 2>&1 || { echo "umount is required for fail-closed rollback" >&2; exit 1; }

validate_root_executable() {
  local executable="$1" description="$2" identity owner mode links
  if [[ "$executable" != /* || ! -f "$executable" || -L "$executable" || ! -x "$executable" ]]; then
    echo "$description must be an absolute, regular, executable, non-symlink file" >&2
    return 1
  fi
  identity="$(stat -Lc '%u:%a:%h' -- "$executable")"
  IFS=: read -r owner mode links <<< "$identity"
  if [[ "$owner" != "0" || "$links" != "1" ]] || (( (8#$mode & 8#022) != 0 )); then
    echo "$description must be root-owned, singly-linked and not group/world writable" >&2
    return 1
  fi
}
validate_root_executable "$PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE" "writer-isolation gate"
validate_root_executable "$PRIVACY_RECOVERY_GATE_EXECUTABLE" "privacy recovery gate"

command -v realpath >/dev/null 2>&1 || { echo "realpath is required to validate restore and mountpoint paths" >&2; exit 1; }
if [[ "$RESTORE_DESTINATION" != /* || ! -d "$RESTORE_DESTINATION" || -L "$RESTORE_DESTINATION" ]]; then
  echo "restore destination must be an absolute real staging directory" >&2
  exit 1
fi
canonical_restore_destination="$(realpath -e -- "$RESTORE_DESTINATION")"
if [[ "$canonical_restore_destination" != "$RESTORE_DESTINATION" ]]; then
  echo "restore destination must not contain symlinked or non-canonical path components" >&2
  exit 1
fi
restore_owner="$(stat -c '%u' -- "$RESTORE_DESTINATION")"
restore_mode="$(stat -c '%a' -- "$RESTORE_DESTINATION")"
if [[ "$restore_owner" != "$(id -u)" ]] || (( (8#$restore_mode & 8#022) != 0 )); then
  echo "restore destination must be owned by the activating user and not group- or world-writable" >&2
  exit 1
fi
pending_marker="$RESTORE_DESTINATION/.vow-restore-pending"
if [[ ! -f "$pending_marker" || -L "$pending_marker" ]]; then
  echo "restore staging state is missing, incomplete, or has already been activated" >&2
  exit 1
fi
pending_owner="$(stat -c '%u' -- "$pending_marker")"
pending_mode="$(stat -c '%a' -- "$pending_marker")"
pending_links="$(stat -c '%h' -- "$pending_marker")"
if [[ "$pending_owner" != "$(id -u)" || "$pending_mode" != "600" || "$pending_links" != "1" ]]; then
  echo "pending marker must be owned by the activating user, mode 0600, and have exactly one hard link" >&2
  exit 1
fi
if [[ ( -e "$RESTORE_DESTINATION/.vow-privacy-reconciled" || -L "$RESTORE_DESTINATION/.vow-privacy-reconciled" ) ||
      ( -e "$RESTORE_DESTINATION/.vow-privacy-activation-incomplete" || -L "$RESTORE_DESTINATION/.vow-privacy-activation-incomplete" ) ]]; then
  echo "restore staging state is missing, incomplete, or has already been activated" >&2
  exit 1
fi
if [[ "$PRIVATE_MEDIA_MOUNTPOINT" != /* || ! -d "$PRIVATE_MEDIA_MOUNTPOINT" || -L "$PRIVATE_MEDIA_MOUNTPOINT" ]]; then
  echo "private media mountpoint must be an absolute existing real directory" >&2
  exit 1
fi
canonical_mountpoint="$(realpath -e -- "$PRIVATE_MEDIA_MOUNTPOINT")"
if [[ "$canonical_mountpoint" != "$PRIVATE_MEDIA_MOUNTPOINT" ]]; then
  echo "private media mountpoint must not contain symlinked or non-canonical path components" >&2
  exit 1
fi
if mountpoint -q -- "$PRIVATE_MEDIA_MOUNTPOINT"; then
  echo "private media mountpoint is already mounted" >&2
  exit 1
fi
if [[ -n "$(find "$PRIVATE_MEDIA_MOUNTPOINT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "private media mountpoint must be empty" >&2
  exit 1
fi

# The public entrypoint must always enter the shared marker-first maintenance
# protocol. The internal phase is accepted only with the helper's inherited
# exclusive lock and its durable maintenance marker already present.
if [[ "${1:-}" != "--vow-internal-activation" ]]; then
  if [[ -n "${PRIVACY_RECOVERY_ADMISSION_EXECUTABLE:-}" ]]; then
    admission_helper="$PRIVACY_RECOVERY_ADMISSION_EXECUTABLE"
  else
    admission_helper="$(realpath -e -- "$(dirname -- "$0")/privacy-recovery-admission.sh")"
  fi
  if [[ "$admission_helper" != /* || ! -f "$admission_helper" || -L "$admission_helper" ]]; then
    echo "privacy-recovery admission helper must be an absolute, regular, non-symlink file" >&2
    exit 1
  fi
  admission_identity="$(stat -c '%u:%a' -- "$admission_helper")"
  IFS=: read -r admission_owner admission_mode <<< "$admission_identity"
  if [[ "$admission_owner" != "0" ]] || (( (8#$admission_mode & 8#022) != 0 )); then
    echo "privacy-recovery admission helper must be root-owned and not group/world writable" >&2
    exit 1
  fi
  exec bash "$admission_helper" maintenance -- bash "$0" --vow-internal-activation
fi
shift

# FD 9 must be the exclusive lock inherited from privacy-recovery-admission.sh.
# Never reopen it here: that would create a separate open-file description and can
# deadlock or invalidate the admission protocol.
maintenance_marker="$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance"
if [[ ! -d "$maintenance_marker" || -L "$maintenance_marker" || ! -e /proc/self/fd/9 ]]; then
  echo "activation requires the inherited maintenance lock and durable admission marker" >&2
  exit 1
fi
if ! flock -n -x 9; then
  echo "activation could not confirm the inherited descriptor holds the exclusive writer-admission lock" >&2
  exit 1
fi
export PRIVACY_RECOVERY_WRITER_LOCK_FILE
export PRIVACY_RECOVERY_WRITER_LOCK_FD=9


# Stop and audit writers before domain reconciliation. This gate must target a dedicated restore-only environment.
# A non-zero result leaves the restore pending and prevents activation.
exec 7< "$PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE"
if [[ "$(stat -Lc '%d:%i' -- /proc/self/fd/7)" != "$(stat -Lc '%d:%i' -- "$PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE")" ]]; then
  echo "writer-isolation gate changed while opening; refusing activation" >&2
  exit 1
fi
RESTORE_DESTINATION="$RESTORE_DESTINATION" bash /proc/self/fd/7

# The verifier owns the domain-specific sequence: inventory, supported replay,
# receipt/queue verification, consent checks, and account/gift reconciliation.
# A non-zero result leaves the restore pending and prevents the bind mount.
exec 6< "$PRIVACY_RECOVERY_GATE_EXECUTABLE"
if [[ "$(stat -Lc '%d:%i' -- /proc/self/fd/6)" != "$(stat -Lc '%d:%i' -- "$PRIVACY_RECOVERY_GATE_EXECUTABLE")" ]]; then
  echo "privacy recovery gate changed while opening; refusing activation" >&2
  exit 1
fi
RESTORE_DESTINATION="$RESTORE_DESTINATION" bash /proc/self/fd/6

# Persist an explicit transition marker before changing either authoritative marker.
# If the process is killed between these operations, a later invocation fails closed
# instead of mistaking a marker gap for a fresh or reconciled restore.
incomplete_marker="$RESTORE_DESTINATION/.vow-privacy-activation-incomplete"
( set -o noclobber; : > "$incomplete_marker" )
chmod 600 "$incomplete_marker"
sync -f "$incomplete_marker"
sync -f "$RESTORE_DESTINATION"

rm -- "$RESTORE_DESTINATION/.vow-restore-pending"
( set -o noclobber; : > "$RESTORE_DESTINATION/.vow-privacy-reconciled" )
chmod 600 "$RESTORE_DESTINATION/.vow-privacy-reconciled"
sync -f "$RESTORE_DESTINATION/.vow-privacy-reconciled"
sync -f "$RESTORE_DESTINATION"
if ! mount --bind -- "$RESTORE_DESTINATION" "$PRIVATE_MEDIA_MOUNTPOINT"; then
  rm -f -- "$RESTORE_DESTINATION/.vow-privacy-reconciled"
  : > "$RESTORE_DESTINATION/.vow-restore-pending"
  chmod 600 "$RESTORE_DESTINATION/.vow-restore-pending"
  sync -f "$RESTORE_DESTINATION"
  rm -- "$incomplete_marker"
  sync -f "$RESTORE_DESTINATION"
  echo "private media bind mount failed; restore returned to pending state" >&2
  exit 1
fi

# A successful mount command is not sufficient evidence: verify that the requested
# target is now an actual mountpoint before clearing the incomplete marker.
if ! mountpoint -q -- "$PRIVATE_MEDIA_MOUNTPOINT"; then
  echo "bind mount command returned success but the private media target is not mounted; activation remains blocked" >&2
  exit 1
fi

# The mount succeeded; only now may a later invocation see a completed state.
# Keep the final marker transition fail-closed even if the process is interrupted
# between unlinking the incomplete marker and completing the directory sync.
handle_finalization_signal() {
  local signal_name="$1"
  trap - TERM INT HUP
  if [[ ! -e "$incomplete_marker" && ! -L "$incomplete_marker" ]]; then
    ( set -o noclobber; : > "$incomplete_marker" ) 2>/dev/null || true
  fi
  chmod 600 "$incomplete_marker" 2>/dev/null || true
  sync -f "$incomplete_marker" 2>/dev/null || true
  sync -f "$RESTORE_DESTINATION" 2>/dev/null || true
  if mountpoint -q -- "$PRIVATE_MEDIA_MOUNTPOINT"; then
    if ! umount -- "$PRIVATE_MEDIA_MOUNTPOINT"; then
      echo "activation signal $signal_name received and bind-mount rollback failed; manual isolation is required" >&2
    fi
  fi
  echo "activation interrupted by $signal_name; incomplete marker restored and activation remains blocked" >&2
  exit 1
}
trap 'handle_finalization_signal TERM' TERM
trap 'handle_finalization_signal INT' INT
trap 'handle_finalization_signal HUP' HUP
rm -- "$incomplete_marker"
if ! sync -f "$RESTORE_DESTINATION"; then
  # The bind mount is already live at this point. Roll it back before returning
  # failure; keep the incomplete marker as a second, durable fail-closed signal.
  if ! umount -- "$PRIVATE_MEDIA_MOUNTPOINT"; then
    echo "final restore-state sync failed and bind-mount rollback also failed; manual isolation is required" >&2
  fi
  ( set -o noclobber; : > "$incomplete_marker" ) 2>/dev/null || true
  chmod 600 "$incomplete_marker" || true
  sync -f "$incomplete_marker" || true
  sync -f "$RESTORE_DESTINATION" || true
  echo "final restore-state sync failed; activation was rolled back where possible and remains blocked by the incomplete marker" >&2
  exit 1
fi
trap - TERM INT HUP

printf 'Private media restore passed the privacy-recovery gate and was mounted.\\n'
