#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${ARCHIVE_FILE:?Set ARCHIVE_FILE to the encrypted PostgreSQL .dump.age backup}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the age private identity file}"
: "${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL to a dedicated, empty staging database}"
: "${RESTORE_CONFIRM_STAGING:?Set RESTORE_CONFIRM_STAGING to I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE}"
if [[ "$RESTORE_CONFIRM_STAGING" != "I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE" ]]; then
  echo "explicit staging-database confirmation is required" >&2
  exit 1
fi

command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore is required" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }

CHECKSUM_FILE="${CHECKSUM_FILE:-${ARCHIVE_FILE}.sha256}"
for file in "$ARCHIVE_FILE" "$CHECKSUM_FILE" "$AGE_IDENTITY_FILE"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "archive, checksum and age identity must be regular non-symlink files" >&2
    exit 1
  fi
done

expected_checksum="$(awk 'NR == 1 { print $1 }' "$CHECKSUM_FILE")"
if ! [[ "$expected_checksum" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "backup checksum file is malformed" >&2
  exit 1
fi
actual_checksum="$(sha256sum "$ARCHIVE_FILE" | awk '{ print $1 }')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo "backup checksum verification failed" >&2
  exit 1
fi

# Never use --clean or drop/create the target. Refuse anything other than an empty staging DB.
empty_state_sql="
SELECT CASE WHEN current_database() IN ('postgres', 'template0', 'template1') THEN -1 ELSE
  (SELECT count(*) FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND nspname NOT LIKE 'pg_toast%')
  +
  (SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public')
  +
  (SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public')
  +
  (SELECT count(*) FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype <> 'p'
      AND t.typcategory <> 'A') END;
"
empty_state="$(psql --dbname="$RESTORE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$empty_state_sql" | tr -d '[:space:]')"
if ! [[ "$empty_state" =~ ^[0-9]+$ ]] || [[ "$empty_state" != "0" ]]; then
  echo "restore target is not an empty staging database; refusing to restore" >&2
  exit 1
fi

# Keep decrypted SQL/custom-format bytes in the pipe only; no plaintext dump is written to disk.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$ARCHIVE_FILE" \
  | pg_restore --dbname="$RESTORE_DATABASE_URL" --exit-on-error --single-transaction --no-owner --no-acl

printf 'Restored encrypted PostgreSQL backup into the verified empty staging database.\n'
printf 'Run application integrity checks and reconcile deletion/consent state before exposing the environment.\n'
