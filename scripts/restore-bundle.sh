#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${BACKUP_BUNDLE_DIR:?Set BACKUP_BUNDLE_DIR to a coordinated backup bundle directory}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the age private identity file}"
: "${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL to a dedicated isolated staging database}"
: "${RESTORE_CONFIRM_STAGING:?Explicit staging restore confirmation is required}"
: "${RESTORE_DESTINATION:?Set RESTORE_DESTINATION to a new isolated media directory}"
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
if [[ ! -d "$BACKUP_BUNDLE_DIR" || -L "$BACKUP_BUNDLE_DIR" ]]; then
  echo "backup bundle must be a real directory, not a symlink" >&2
  exit 1
fi
BUNDLE_DIR="$(cd -- "$BACKUP_BUNDLE_DIR" && pwd -P)"
for file in "$BUNDLE_DIR/manifest.txt" "$BUNDLE_DIR/manifest.sha256" "$AGE_IDENTITY_FILE"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "bundle manifest and age identity must be regular non-symlink files" >&2
    exit 1
  fi
done
(cd -- "$BUNDLE_DIR" && sha256sum --check --status manifest.sha256) || {
  echo "backup bundle manifest checksum verification failed" >&2
  exit 1
}
mapfile -t manifest_lines < "$BUNDLE_DIR/manifest.txt"
if [[ "${#manifest_lines[@]}" -eq 7 && "${manifest_lines[0]}" == "format=vow-backup-bundle-v2" ]]; then
  SNAPSHOT_ID="${manifest_lines[1]#snapshot_id=}"
  SNAPSHOT_CONSISTENCY="${manifest_lines[2]#snapshot_consistency=}"
  POSTGRES_ARCHIVE="${manifest_lines[3]#postgres_archive=}"
  POSTGRES_SHA256="${manifest_lines[4]#postgres_sha256=}"
  MEDIA_ARCHIVE="${manifest_lines[5]#private_media_archive=}"
  MEDIA_SHA256="${manifest_lines[6]#private_media_sha256=}"
  if [[ "${manifest_lines[2]}" != "snapshot_consistency=best_effort_non_atomic" ]]; then
    echo "backup bundle consistency declaration is invalid" >&2
    exit 1
  fi
elif [[ "${#manifest_lines[@]}" -eq 6 && "${manifest_lines[0]}" == "format=vow-backup-bundle-v1" ]]; then
  # Legacy v1 bundles predate an explicit consistency declaration. Treat them
  # as unverified pairs and keep the restore target isolated.
  SNAPSHOT_ID="${manifest_lines[1]#snapshot_id=}"
  SNAPSHOT_CONSISTENCY="legacy_unverified"
  POSTGRES_ARCHIVE="${manifest_lines[2]#postgres_archive=}"
  POSTGRES_SHA256="${manifest_lines[3]#postgres_sha256=}"
  MEDIA_ARCHIVE="${manifest_lines[4]#private_media_archive=}"
  MEDIA_SHA256="${manifest_lines[5]#private_media_sha256=}"
else
  echo "backup bundle manifest format is invalid" >&2
  exit 1
fi
if [[ "${manifest_lines[1]}" != "snapshot_id=$SNAPSHOT_ID" ||
      ! "$SNAPSHOT_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ||
      "$POSTGRES_ARCHIVE" != "postgres/vow-postgres-$SNAPSHOT_ID.dump.age" ||
      "$MEDIA_ARCHIVE" != "private-media/vow-private-media-$SNAPSHOT_ID.tar.age" ||
      ! "$POSTGRES_SHA256" =~ ^[[:xdigit:]]{64}$ ||
      ! "$MEDIA_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "backup bundle manifest identity or artifact mapping is invalid" >&2
  exit 1
fi
POSTGRES_FILE="$BUNDLE_DIR/$POSTGRES_ARCHIVE"
MEDIA_FILE="$BUNDLE_DIR/$MEDIA_ARCHIVE"
for file in "$POSTGRES_FILE" "$POSTGRES_FILE.sha256" "$MEDIA_FILE" "$MEDIA_FILE.sha256"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "backup bundle artifact is missing or is not a regular file" >&2
    exit 1
  fi
done
actual_postgres_sha256="$(sha256sum "$POSTGRES_FILE" | awk '{ print $1 }')"
actual_media_sha256="$(sha256sum "$MEDIA_FILE" | awk '{ print $1 }')"
if [[ "$actual_postgres_sha256" != "$POSTGRES_SHA256" || "$actual_media_sha256" != "$MEDIA_SHA256" ]]; then
  echo "backup bundle artifact checksum does not match its manifest" >&2
  exit 1
fi
ARCHIVE_FILE="$POSTGRES_FILE" AGE_IDENTITY_FILE="$AGE_IDENTITY_FILE" \
  RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" \
  RESTORE_CONFIRM_STAGING="$RESTORE_CONFIRM_STAGING" \
  bash "$SCRIPT_DIR/restore-postgres.sh"
ARCHIVE_FILE="$MEDIA_FILE" AGE_IDENTITY_FILE="$AGE_IDENTITY_FILE" \
  RESTORE_DESTINATION="$RESTORE_DESTINATION" \
  bash "$SCRIPT_DIR/restore-private-media.sh"
printf 'Restored coordinated backup snapshot %s into isolated staging targets.\n' "$SNAPSHOT_ID"
printf 'Keep the database and media isolated until privacy-ledger reconciliation and verification are complete.\n'
