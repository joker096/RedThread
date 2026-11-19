#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${RESTORE_DESTINATION:?Set RESTORE_DESTINATION to the isolated restore staging directory}"
: "${PRIVATE_MEDIA_MOUNTPOINT:?Set PRIVATE_MEDIA_MOUNTPOINT to an existing empty mountpoint}"
: "${PRIVACY_RECOVERY_GATE_EXECUTABLE:?Set PRIVACY_RECOVERY_GATE_EXECUTABLE to the executable domain-reconciliation gate}"
: "${PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE:?Set PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE to the Docker/host writer-isolation gate}"

command -v mount >/dev/null 2>&1 || { echo "mount is required" >&2; exit 1; }
command -v mountpoint >/dev/null 2>&1 || { echo "mountpoint is required" >&2; exit 1; }

for gate in "$PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE" "$PRIVACY_RECOVERY_GATE_EXECUTABLE"; do
  if [[ ! "$gate" = /* || ! -f "$gate" || -L "$gate" || ! -x "$gate" ]]; then
    echo "privacy recovery gates must be absolute, regular, executable, non-symlink files" >&2
    exit 1
  fi
done

if [[ ! -d "$RESTORE_DESTINATION" || -L "$RESTORE_DESTINATION" ]]; then
  echo "restore destination must be a real staging directory" >&2
  exit 1
fi
if [[ ! -f "$RESTORE_DESTINATION/.vow-restore-pending" ||
      -L "$RESTORE_DESTINATION/.vow-restore-pending" ||
      -e "$RESTORE_DESTINATION/.vow-privacy-reconciled" ]]; then
  echo "restore staging state is missing or has already been activated" >&2
  exit 1
fi
if [[ ! -d "$PRIVATE_MEDIA_MOUNTPOINT" || -L "$PRIVATE_MEDIA_MOUNTPOINT" ]]; then
  echo "private media mountpoint must be an existing real directory" >&2
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

# Stop and audit writers before domain reconciliation. This gate must target a dedicated restore-only environment.
# A non-zero result leaves the restore pending and prevents activation.
RESTORE_DESTINATION="$RESTORE_DESTINATION" "$PRIVACY_RECOVERY_WRITER_ISOLATION_EXECUTABLE"

# The verifier owns the domain-specific sequence: inventory, supported replay,
# receipt/queue verification, consent checks, and account/gift reconciliation.
# A non-zero result leaves the restore pending and prevents the bind mount.
RESTORE_DESTINATION="$RESTORE_DESTINATION" "$PRIVACY_RECOVERY_GATE_EXECUTABLE"

rm -- "$RESTORE_DESTINATION/.vow-restore-pending"
: > "$RESTORE_DESTINATION/.vow-privacy-reconciled"
chmod 600 "$RESTORE_DESTINATION/.vow-privacy-reconciled"
if ! mount --bind -- "$RESTORE_DESTINATION" "$PRIVATE_MEDIA_MOUNTPOINT"; then
  rm -f -- "$RESTORE_DESTINATION/.vow-privacy-reconciled"
  : > "$RESTORE_DESTINATION/.vow-restore-pending"
  chmod 600 "$RESTORE_DESTINATION/.vow-restore-pending"
  echo "private media bind mount failed; restore returned to pending state" >&2
  exit 1
fi

printf 'Private media restore passed the privacy-recovery gate and was mounted.\\n'
