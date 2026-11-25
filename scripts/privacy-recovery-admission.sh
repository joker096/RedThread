#!/usr/bin/env bash
# Cross-UID admission for private-media writers and root-only maintenance.
# This is cooperative coordination; it is not a substitute for host isolation.
set -Eeuo pipefail
umask 027

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
: "${PRIVACY_RECOVERY_WRITER_GID:?Set the numeric shared writer group ID}"
lock_file="$PRIVACY_RECOVERY_WRITER_LOCK_FILE"
writer_gid="$PRIVACY_RECOVERY_WRITER_GID"
if [[ ! "$writer_gid" =~ ^[1-9][0-9]*$ ]]; then
  echo "writer group ID must be a positive numeric GID" >&2
  exit 1
fi
if [[ "$lock_file" != /* || ! -f "$lock_file" || -L "$lock_file" ]]; then
  echo "writer-admission lock must be an absolute regular non-symlink file" >&2
  exit 1
fi
for utility in stat realpath flock sync id; do
  command -v "$utility" >/dev/null 2>&1 || { echo "$utility is required" >&2; exit 1; }
done

lock_dir="$(dirname -- "$lock_file")"
canonical_dir="$(realpath -e -- "$lock_dir")"
if [[ "$canonical_dir" != "$lock_dir" || -L "$lock_dir" ]]; then
  echo "writer-admission lock directory must be canonical and non-symlinked" >&2
  exit 1
fi

dir_identity="$(stat -Lc '%u:%g:%a:%d:%i' -- "$lock_dir")"
file_identity="$(stat -Lc '%u:%g:%a:%d:%i' -- "$lock_file")"
IFS=: read -r dir_owner dir_group dir_mode dir_dev dir_ino <<< "$dir_identity"
IFS=: read -r file_owner file_group file_mode file_dev file_ino <<< "$file_identity"
if [[ "$dir_owner" != "0" || "$dir_group" != "$writer_gid" || "$dir_mode" != "2750" ]]; then
  echo "writer-admission directory must be root:<writer-gid> mode 2750" >&2
  exit 1
fi
if [[ "$file_owner" != "0" || "$file_group" != "$writer_gid" || "$file_mode" != "640" ]]; then
  echo "writer-admission lock must be root:<writer-gid> mode 0640" >&2
  exit 1
fi

uid="$(id -u)"
if [[ "$mode" == "writer" ]]; then
  if [[ "$uid" == "0" ]]; then
    echo "writer admission must run as an unprivileged service account" >&2
    exit 1
  fi
  groups=" $(id -G) "
  if [[ "$groups" != *" $writer_gid "* ]]; then
    echo "writer process is not a member of the configured shared group" >&2
    exit 1
  fi
else
  if [[ "$uid" != "0" ]]; then
    echo "maintenance admission is root-only" >&2
    exit 1
  fi
fi

marker="$lock_file.maintenance"
if [[ -L "$marker" ]]; then
  echo "maintenance marker must not be a symlink" >&2
  exit 1
fi

# Writers deliberately open the root-owned lock read-only. Maintenance opens
# it read-write because it must hold an exclusive flock.
if [[ "$mode" == "writer" ]]; then
  exec 9< "$lock_file"
else
  exec 9<> "$lock_file"
fi

# Compare the opened descriptor with the path after open to detect replacement
# between initial validation and descriptor acquisition. The lock directory is
# root-owned and not writable by the service group, closing writer-side swaps.
fd_identity="$(stat -Lc '%d:%i' -- /proc/self/fd/9)"
path_identity="$(stat -Lc '%d:%i' -- "$lock_file")"
if [[ "$fd_identity" != "$path_identity" || "$fd_identity" != "$file_dev:$file_ino" ]]; then
  echo "writer-admission lock changed while opening; refusing admission" >&2
  exit 1
fi

if [[ "$mode" == "writer" ]]; then
  # Serialize marker observation with maintenance marker creation.
  flock -s 9
  if [[ -e "$marker" ]]; then
    echo "writer admission is closed for privacy-recovery maintenance" >&2
    exit 75
  fi
  exec "$@"
fi

# Root closes admission before draining existing readers. The marker is sticky:
# errors, signals and reboots do not silently reopen writer access.
if ! mkdir -m 2750 -- "$marker"; then
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
drain_identity="$(stat -Lc '%u:%a:%h' -- "$drain")"
IFS=: read -r drain_owner drain_mode drain_links <<< "$drain_identity"
if [[ "$drain_owner" != "0" || "$drain_links" != "1" || ! -x "$drain" ]] || (( (8#$drain_mode & 8#022) != 0 )); then
  echo "drain controller must be root-owned, singly-linked, executable and not group/world writable" >&2
  exit 1
fi
# Open and validate the exact inode, then execute the pinned descriptor to
# prevent a path replacement between the trust check and process launch.
exec 8< "$drain"
fd_drain_identity="$(stat -Lc '%u:%a:%h:%d:%i' -- /proc/self/fd/8)"
path_drain_identity="$(stat -Lc '%u:%a:%h:%d:%i' -- "$drain")"
if [[ "$fd_drain_identity" != "$path_drain_identity" ]]; then
  echo "drain controller changed while opening; refusing maintenance" >&2
  exit 1
fi
IFS=: read -r fd_drain_owner fd_drain_mode fd_drain_links _ _ <<< "$fd_drain_identity"
if [[ "$fd_drain_owner" != "0" || "$fd_drain_links" != "1" ]] || (( (8#$fd_drain_mode & 8#022) != 0 )); then
  echo "opened drain controller is not trusted" >&2
  exit 1
fi
if ! bash /proc/self/fd/8; then
  echo "writer drain controller failed; admission remains closed" >&2
  exit 1
fi

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
