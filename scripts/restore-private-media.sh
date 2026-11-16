#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${ARCHIVE_FILE:?Set ARCHIVE_FILE to the encrypted .tar.age backup}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the age private identity file}"
: "${RESTORE_DESTINATION:?Set RESTORE_DESTINATION to a new isolated destination directory}"

command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for safe archive validation" >&2; exit 1; }

CHECKSUM_FILE="${CHECKSUM_FILE:-${ARCHIVE_FILE}.sha256}"
for file in "$ARCHIVE_FILE" "$CHECKSUM_FILE" "$AGE_IDENTITY_FILE"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "archive, checksum and age identity must be regular non-symlink files" >&2
    exit 1
  fi
done

# Snapshot the encrypted archive, checksum and identity through O_NOFOLLOW file
# descriptors. Every later checksum/decrypt pass reads these same private copies,
# so replacing the source archive between validation and extraction cannot race us.
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/vow-private-media-restore.XXXXXX")"
destination=""
destination_created=0
restore_complete=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$restore_complete" -ne 1 && "$destination_created" -eq 1 ]]; then
    rm -rf -- "$destination"
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
  return "$status"
}
trap cleanup EXIT
chmod 700 "$work_dir"

archive_snapshot="$work_dir/archive.tar.age"
checksum_snapshot="$work_dir/archive.sha256"
identity_snapshot="$work_dir/age.identity"
python3 - "$ARCHIVE_FILE" "$archive_snapshot" "$CHECKSUM_FILE" "$checksum_snapshot" "$AGE_IDENTITY_FILE" "$identity_snapshot" <<'PY'
import os, stat, sys

pairs = [
    (sys.argv[1], sys.argv[2], None),
    (sys.argv[3], sys.argv[4], 4096),
    (sys.argv[5], sys.argv[6], 65536),
]
for source, destination, max_size in pairs:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    source_fd = os.open(source, flags)
    destination_fd = None
    try:
        metadata = os.fstat(source_fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("restore inputs must be regular files")
        if max_size is not None and metadata.st_size > max_size:
            raise ValueError("restore metadata file is too large")
        destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]
        os.fsync(destination_fd)
    finally:
        os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
PY

expected_checksum="$(awk 'NR == 1 { print $1 }' "$checksum_snapshot")"
if ! [[ "$expected_checksum" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "backup checksum file is malformed" >&2
  exit 1
fi
actual_checksum="$(sha256sum "$archive_snapshot" | awk '{ print $1 }')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo "backup checksum verification failed" >&2
  exit 1
fi

# Validate the decrypted tar stream before extraction. Private-media backups
# contain only regular files and directories; links and special entries are
# unnecessary and can redirect extraction outside the staging directory.
age --decrypt --identity "$identity_snapshot" "$archive_snapshot" |
  python3 -c '
import posixpath, sys, tarfile
seen = {}
try:
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
        for member in archive:
            name = member.name
            if not name or name.startswith("/") or "\x00" in name:
                raise ValueError("unsafe archive member path")
            parts = name.split("/")
            if any(part == ".." for part in parts):
                raise ValueError("parent traversal in archive member path")
            normalized = posixpath.normpath(name)
            if normalized in ("", "."):
                if member.isdir():
                    continue
                raise ValueError("invalid archive root member")
            if normalized.startswith("../") or normalized == ".." or normalized.startswith("/"):
                raise ValueError("archive member escapes staging directory")
            if not (member.isdir() or member.isfile()):
                raise ValueError("archive contains a link or special filesystem entry")
            if normalized in seen:
                raise ValueError("archive contains duplicate member paths")
            seen[normalized] = "directory" if member.isdir() else "file"
    for name, kind in seen.items():
        parts = name.split("/")
        for index in range(1, len(parts)):
            parent = "/".join(parts[:index])
            if seen.get(parent) == "file":
                raise ValueError("archive file is used as a parent directory")
        if kind == "file" and any(other.startswith(name + "/") for other in seen):
            raise ValueError("archive file conflicts with a child path")
except Exception as error:
    print("private media archive validation failed: " + str(error), file=sys.stderr)
    sys.exit(1)
'

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
destination_created=1

# Decrypt only into tar's input stream; never create a plaintext archive file.
age --decrypt --identity "$identity_snapshot" "$archive_snapshot" \
  | tar --extract --file=- --directory="$destination" --no-same-owner --no-same-permissions

: > "$destination/.vow-restore-pending"
chmod 600 "$destination/.vow-restore-pending"
restore_complete=1
printf 'Restored encrypted media archive into isolated staging directory: %s\\n' "$destination"
printf 'Media remains blocked from activation until the privacy-recovery gate succeeds.\\n'
