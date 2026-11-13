#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${ARCHIVE_FILE:?Set ARCHIVE_FILE to the encrypted .tar.age backup}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the age private identity file}"
: "${RESTORE_DESTINATION:?Set RESTORE_DESTINATION to a new isolated destination directory}"

command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }

CHECKSUM_FILE="${CHECKSUM_FILE:-${ARCHIVE_FILE}.sha256}"
for file in "$ARCHIVE_FILE" "$CHECKSUM_FILE" "$AGE_IDENTITY_FILE"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "archive, checksum and age identity must be regular non-symlink files" >&2
    exit 1
  fi
done

if ! sha256sum --check --status "$CHECKSUM_FILE"; then
  echo "backup checksum verification failed" >&2
  exit 1
fi

destination_parent="$(dirname -- "$RESTORE_DESTINATION")"
destination_name="$(basename -- "$RESTORE_DESTINATION")"
if [[ "$destination_name" == "." || "$destination_name" == "/" || -z "$destination_name" ||
      ! -d "$destination_parent" || -L "$destination_parent" ]]; then
  echo "restore destination parent must be an existing real directory" >&2
  exit 1
fi
destination_parent="$(cd -- "$destination_parent" && pwd -P)"
destination="$destination_parent/$destination_name"
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "restore destination must not already exist" >&2
  exit 1
fi

mkdir -m 700 -- "$destination"
restore_complete=0
cleanup() {
  status=$?
  if [[ "$restore_complete" -ne 1 ]]; then
    rm -rf -- "$destination"
  fi
  exit "$status"
}
trap cleanup EXIT

# Decrypt only into tar's input stream; never create a plaintext archive file.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$ARCHIVE_FILE" \
  | tar --extract --file=- --directory="$destination" --no-same-owner --no-same-permissions

restore_complete=1
trap - EXIT
printf 'Restored encrypted media archive into isolated staging directory: %s\n' "$destination"
printf 'Reconcile deletion tombstones, consent, moderation and application references before mounting it.\n'
