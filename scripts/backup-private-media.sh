#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${PRIVATE_MEDIA_DIR:?Set PRIVATE_MEDIA_DIR to the mounted private media directory}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT to an age public recipient; plaintext backups are disabled}"
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }

if [[ ! -d "$PRIVATE_MEDIA_DIR" || -L "$PRIVATE_MEDIA_DIR" ]]; then
  echo "private media root must be a real directory, not a symlink" >&2
  exit 1
fi
MEDIA_ROOT="$(cd -- "$PRIVATE_MEDIA_DIR" && pwd -P)"
if find "$MEDIA_ROOT" -type l -print -quit | grep -q .; then
  echo "private media contains symlinks; refusing an ambiguous backup" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups/private-media}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_ROOT="$(cd -- "$BACKUP_DIR" && pwd -P)"
case "$BACKUP_ROOT/" in
  "$MEDIA_ROOT/"*) echo "backup directory must not be inside the private media root" >&2; exit 1 ;;
esac
case "$MEDIA_ROOT/" in
  "$BACKUP_ROOT/"*) echo "private media root must not be inside the backup directory" >&2; exit 1 ;;
esac

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_ROOT/vow-private-media-$timestamp.tar.age"
temporary_file="$backup_file.tmp"
trap 'rm -f -- "$temporary_file"' EXIT

# Stream archive bytes directly into age. No plaintext archive is written to disk.
tar --create --file=- --directory="$MEDIA_ROOT" --one-file-system --numeric-owner --xattrs --acls . \
  | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
chmod 600 "$backup_file.sha256"
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'vow-private-media-*.tar.age*' -mtime "+$RETENTION_DAYS" -delete

printf 'Created encrypted private-media backup: %s\n' "$backup_file"
printf 'Verify its checksum and perform a restore drill before relying on it.\n'
