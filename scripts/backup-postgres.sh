#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# A PostgreSQL dump is part of the privacy-recovery snapshot and must hold
# the same shared admission lock for the entire pg_dump/age stream. Direct
# invocation without the helper is rejected; FD 9 must be the configured inode
# with a live shared flock, and maintenance must not have closed admission.
: "${PRIVACY_RECOVERY_WRITER_LOCK_FILE:?Run through privacy-recovery-admission.sh writer}"
if [[ ! -e /proc/self/fd/9 || ! -r /proc/self/fdinfo/9 ]]; then
  echo "PostgreSQL backup requires the inherited admission lock on FD 9" >&2
  exit 1
fi
lock_real="$(realpath -e -- "$PRIVACY_RECOVERY_WRITER_LOCK_FILE")"
fd_real="$(readlink -f -- /proc/self/fd/9)"
if [[ "$fd_real" != "$lock_real" ]] ||
   ! grep -Eq '^lock:[[:space:]]*[0-9]+:[[:space:]]+FLOCK[[:space:]]+ADVISORY[[:space:]]+READ[[:space:]]' /proc/self/fdinfo/9; then
  echo "PostgreSQL backup requires the configured live shared admission lock on FD 9" >&2
  exit 1
fi
if [[ -e "$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance" || -L "$PRIVACY_RECOVERY_WRITER_LOCK_FILE.maintenance" ]]; then
  echo "PostgreSQL backup admission is closed for privacy-recovery maintenance" >&2
  exit 75
fi

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
snapshot_id="${BACKUP_SNAPSHOT_ID:-$timestamp}"
if ! [[ "$snapshot_id" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "BACKUP_SNAPSHOT_ID must contain 1-64 ASCII letters, digits, underscores or hyphens" >&2
  exit 1
fi
backup_file="$BACKUP_DIR/vow-postgres-$snapshot_id.dump.age"
temporary_file="$backup_file.tmp"
if [[ -e "$backup_file" || -L "$backup_file" || -e "$backup_file.sha256" || -L "$backup_file.sha256" ]]; then
  echo "refusing to overwrite an existing PostgreSQL backup snapshot" >&2
  exit 1
fi
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
