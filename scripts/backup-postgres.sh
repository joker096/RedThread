#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DATABASE_URL:?Set DATABASE_URL through your deployment secret manager}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/vow-postgres-$timestamp.dump"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'vow-postgres-*.dump*' -mtime "+$RETENTION_DAYS" -delete
printf 'Created backup: %s\n' "$backup_file"
printf 'Copy to encrypted off-site storage and periodically test restoration.\n'
