#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${DATABASE_URL:?Set DATABASE_URL through your deployment secret manager}"
: "${PRIVATE_MEDIA_DIR:?Set PRIVATE_MEDIA_DIR to the mounted private media directory}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT to an age public recipient}"
BACKUP_ROOT="${BACKUP_DIR:-./backups/bundles}"
SNAPSHOT_ID="${BACKUP_SNAPSHOT_ID:-$(date -u +%Y%m%dT%H%M%SZ)_$$}"
if ! [[ "$SNAPSHOT_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "BACKUP_SNAPSHOT_ID must contain 1-64 ASCII letters, digits, underscores or hyphens" >&2
  exit 1
fi
mkdir -p -- "$BACKUP_ROOT"
chmod 700 -- "$BACKUP_ROOT"
BACKUP_ROOT="$(cd -- "$BACKUP_ROOT" && pwd -P)"
BUNDLE_DIR="$BACKUP_ROOT/$SNAPSHOT_ID"
if [[ -e "$BUNDLE_DIR" || -L "$BUNDLE_DIR" ]]; then
  echo "backup bundle snapshot already exists; refusing to overwrite it" >&2
  exit 1
fi
mkdir -m 700 -- "$BUNDLE_DIR"
complete=0
cleanup() {
  status=$?
  if [[ "$complete" -ne 1 ]]; then rm -rf -- "$BUNDLE_DIR"; fi
  exit "$status"
}
trap cleanup EXIT
BACKUP_DIR="$BUNDLE_DIR/postgres" BACKUP_SNAPSHOT_ID="$SNAPSHOT_ID" bash "$SCRIPT_DIR/backup-postgres.sh"
BACKUP_DIR="$BUNDLE_DIR/private-media" BACKUP_SNAPSHOT_ID="$SNAPSHOT_ID" bash "$SCRIPT_DIR/backup-private-media.sh"
POSTGRES_NAME="vow-postgres-$SNAPSHOT_ID.dump.age"
MEDIA_NAME="vow-private-media-$SNAPSHOT_ID.tar.age"
POSTGRES_FILE="$BUNDLE_DIR/postgres/$POSTGRES_NAME"
MEDIA_FILE="$BUNDLE_DIR/private-media/$MEDIA_NAME"
for file in "$POSTGRES_FILE" "$POSTGRES_FILE.sha256" "$MEDIA_FILE" "$MEDIA_FILE.sha256"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "backup bundle is incomplete or contains a non-regular artifact" >&2
    exit 1
  fi
done
POSTGRES_SHA256="$(sha256sum "$POSTGRES_FILE" | awk '{ print $1 }')"
MEDIA_SHA256="$(sha256sum "$MEDIA_FILE" | awk '{ print $1 }')"
cat > "$BUNDLE_DIR/manifest.txt" <<MANIFEST
format=vow-backup-bundle-v2
snapshot_id=$SNAPSHOT_ID
snapshot_consistency=best_effort_non_atomic
postgres_archive=postgres/$POSTGRES_NAME
postgres_sha256=$POSTGRES_SHA256
private_media_archive=private-media/$MEDIA_NAME
private_media_sha256=$MEDIA_SHA256
MANIFEST
chmod 600 "$BUNDLE_DIR/manifest.txt"
(cd -- "$BUNDLE_DIR" && sha256sum manifest.txt > manifest.sha256)
chmod 600 "$BUNDLE_DIR/manifest.sha256"
complete=1
trap - EXIT
printf 'Created coordinated encrypted Vow backup bundle: %s\n' "$BUNDLE_DIR"
printf 'Snapshot ID: %s\n' "$SNAPSHOT_ID"
printf 'Keep the PostgreSQL and private-media artifacts together; restore only into isolated staging targets.\n'
