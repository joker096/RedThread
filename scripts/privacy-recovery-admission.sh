#!/usr/bin/env bash
# Cooperative writer admission primitive for privacy-recovery maintenance.
# This helper is NOT host isolation: every writer launch path must be forced
# through it, and the host gate must independently enforce that boundary.
set -Eeuo pipefail
umask 077

mode="${1:-}"
if [[ "$mode" != "writer" && "$mode" != "maintenance" ]]; then
  echo "usage: privacy-recovery-admission.sh writer -- command... | maintenance -- command..." >&2
  exit 64
fi
shift
if [[ "${1:-}" == "--" ]]; then shift; fi
if [[ "$#" -eq 0 ]]; then
  echo "a command is required" >&2
  exit 64
fi

: "${PRIVACY_RECOVERY_WRITER_LOCK_FILE:?Set the shared writer-admission lock file}"
lock_file="$PRIVACY_RECOVERY_WRITER_LOCK_FILE"
if [[ "$lock_file" != /* || ! -f "$lock_file" || -L "$lock_file" ]]; then
  echo "writer-admission lock must be an absolute regular non-symlink file" >&2
  exit 1
fi
command -v stat >/dev/null 2>&1 || { echo "stat is required" >&2; exit 1; }
command -v realpath >/dev/null 2>&1 || { echo "realpath is required" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 1; }
command -v sync >/dev/null 2>&1 || { echo "sync is required" >&2; exit 1; }

lock_dir="$(dirname -- "$lock_file")"
lock_name="$(basename -- "$lock_file")"
canonical_dir="$(realpath -e -- "$lock_dir")"
if [[ "$canonical_dir" != "$lock_dir" || -L "$lock_dir" ]]; then
  echo "writer-admission lock directory must be canonical and non-symlinked" >&2
  exit 1
fi
dir_mode="$(stat -c '%a' -- "$lock_dir")"
file_owner="$(stat -c '%u' -- "$lock_file")"
file_mode="$(stat -c '%a' -- "$lock_file")"
if (( (8#$dir_mode & 8#022) != 0 )); then
  echo "writer-admission lock directory must not be group- or world-writable" >&2
  exit 1
fi
if [[ "$file_owner" != "$(id -u)" ]] || (( (8#$file_mode & 8#077) != 0 )); then
  echo "writer-admission lock must be owned by the caller and inaccessible to group/others" >&2
  exit 1
fi

marker="$lock_file.maintenance"
exec 9<> "$lock_file"

if [[ "$mode" == "writer" ]]; then
  # The marker check is serialized with maintenance by the shared lock:
  # a writer either observes the marker and rejects, or was admitted before
  # marker creation and must be drained before maintenance gets the EX lock.
  flock -s 9
  if [[ -e "$marker" || -L "$marker" ]]; then
    echo "writer admission is closed for privacy-recovery maintenance" >&2
    exit 75
  fi
  exec "$@"
fi

# Close admission atomically BEFORE draining existing shared-lock holders.
# The marker is deliberately sticky: failures, signals and reboots do not
# reopen writers. Recovery must explicitly inspect state before any reopening.
if ! mkdir -m 700 -- "$marker"; then
  echo "maintenance marker already exists or cannot be created; refusing to reopen admission" >&2
  exit 1
fi
sync -f "$lock_dir"

: "${PRIVACY_RECOVERY_DRAIN_EXECUTABLE:?Set an executable drain controller}"
drain="$PRIVACY_RECOVERY_DRAIN_EXECUTABLE"
if [[ "$drain" != /* || ! -f "$drain" || -L "$drain" || ! -x "$drain" ]]; then
  echo "drain controller must be an absolute regular executable non-symlink file" >&2
  exit 1
fi
"$drain"

timeout="${PRIVACY_RECOVERY_LOCK_TIMEOUT_SECONDS:-30}"
if [[ ! "$timeout" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "lock timeout must be a non-negative number of seconds" >&2
  exit 1
fi
if ! flock -x -w "$timeout" 9; then
  echo "existing writer admission locks did not drain before the timeout" >&2
  exit 1
fi

# Keep FD 9 and the EX lock for the full critical command lifetime.
exec "$@"
