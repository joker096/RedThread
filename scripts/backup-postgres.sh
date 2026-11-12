#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DATABASE_URL:?Set DATABASE_URL through your deployment secret manager}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT to an age public recipient; plaintext backups are disabled}"
command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required; install age before creating encrypted backups" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/vow-postgres-$timestamp.dump.age"
temporary_file="$backup_file.tmp"
cleanup() {
  rm -f "$temporary_file"
}
trap cleanup EXIT

# Stream pg_dump directly into age: plaintext database contents never touch disk.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl \
  | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
chmod 600 "$backup_file.sha256"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'vow-postgres-*.dump.age*' -mtime "+$RETENTION_DAYS" -delete
printf 'Created encrypted backup: %s\n' "$backup_file"
printf 'Copy it to encrypted off-site storage and periodically test restoration.\n'
