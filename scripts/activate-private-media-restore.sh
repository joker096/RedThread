#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${RESTORE_DESTINATION:?Set RESTORE_DESTINATION to the isolated restore staging directory}"
: "${PRIVATE_MEDIA_MOUNTPOINT:?Set PRIVATE_MEDIA_MOUNTPOINT to an existing empty mountpoint}"
: "${PRIVACY_RECOVERY_GATE_EXECUTABLE:?Set PRIVACY_RECOVERY_GATE_EXECUTABLE to the executable domain-reconciliation gate}"

command -v mount >/dev/null 2>&1 || { echo "mount is required" >&2; exit 1; }
command -v mountpoint >/dev/null 2>&1 || { echo "mountpoint is required" >&2; exit 1; }

# Never activate a best-effort or legacy artifact pair. A future v3 bundle must
# carry a barrier watermark and a proof whose digest is pinned in the manifest.
manifest_file="$RESTORE_DESTINATION/.vow-backup-manifest"
manifest_checksum="$RESTORE_DESTINATION/.vow-backup-manifest.sha256"
barrier_proof="$RESTORE_DESTINATION/.vow-snapshot-barrier-proof.json"
for file in "$manifest_file" "$manifest_checksum" "$barrier_proof"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "activation requires an atomic v3 backup manifest and a regular snapshot barrier proof" >&2
    exit 1
  fi
done
(cd -- "$RESTORE_DESTINATION" && sha256sum --check --status .vow-backup-manifest.sha256) || {
  echo "restore staging manifest checksum verification failed" >&2
  exit 1
}
mapfile -t snapshot_manifest_lines < "$manifest_file"
if [[ "${#snapshot_manifest_lines[@]}" -ne 10 ||
      "${snapshot_manifest_lines[0]}" != "format=vow-backup-bundle-v3" ||
      "${snapshot_manifest_lines[2]}" != "snapshot_consistency=atomic" ]]; then
  echo "only explicitly atomic v3 backup bundles can be activated; legacy and best-effort bundles remain isolated" >&2
  exit 1
fi
SNAPSHOT_ID="${snapshot_manifest_lines[1]#snapshot_id=}"
SNAPSHOT_WATERMARK="${snapshot_manifest_lines[3]#snapshot_ledger_sequence=}"
SNAPSHOT_BARRIER_ID="${snapshot_manifest_lines[4]#snapshot_barrier_id=}"
SNAPSHOT_PROOF_SHA256="${snapshot_manifest_lines[5]#snapshot_barrier_proof_sha256=}"
if [[ "${snapshot_manifest_lines[1]}" != "snapshot_id=$SNAPSHOT_ID" ||
      ! "$SNAPSHOT_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ||
      "${snapshot_manifest_lines[3]}" != "snapshot_ledger_sequence=$SNAPSHOT_WATERMARK" ||
      ! "$SNAPSHOT_WATERMARK" =~ ^[0-9]{1,15}$ ||
      "${snapshot_manifest_lines[4]}" != "snapshot_barrier_id=$SNAPSHOT_BARRIER_ID" ||
      ! "$SNAPSHOT_BARRIER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ||
      "${snapshot_manifest_lines[5]}" != "snapshot_barrier_proof_sha256=$SNAPSHOT_PROOF_SHA256" ||
      ! "$SNAPSHOT_PROOF_SHA256" =~ ^[0-9a-fA-F]{64}$ ||
      "${snapshot_manifest_lines[6]}" != "postgres_archive=postgres/vow-postgres-$SNAPSHOT_ID.dump.age" ||
      ! "${snapshot_manifest_lines[7]}" =~ ^postgres_sha256=[0-9a-fA-F]{64}$ ||
      "${snapshot_manifest_lines[8]}" != "private_media_archive=private-media/vow-private-media-$SNAPSHOT_ID.tar.age" ||
      ! "${snapshot_manifest_lines[9]}" =~ ^private_media_sha256=[0-9a-fA-F]{64}$ ]]; then
  echo "atomic backup manifest identity, watermark or artifact mapping is invalid" >&2
  exit 1
fi
actual_proof_sha256="$(sha256sum "$barrier_proof" | awk '{ print $1 }')"
if [[ "$actual_proof_sha256" != "$SNAPSHOT_PROOF_SHA256" ]]; then
  echo "snapshot barrier proof checksum does not match the atomic backup manifest" >&2
  exit 1
fi

if [[ ! "$PRIVACY_RECOVERY_GATE_EXECUTABLE" = /* ||
      ! -f "$PRIVACY_RECOVERY_GATE_EXECUTABLE" ||
      -L "$PRIVACY_RECOVERY_GATE_EXECUTABLE" ||
      ! -x "$PRIVACY_RECOVERY_GATE_EXECUTABLE" ]]; then
  echo "privacy recovery gate must be an absolute, regular, executable, non-symlink file" >&2
  exit 1
fi

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
