#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${RESTORE_COMPOSE_PROJECT:?Set a dedicated restore-only Compose project name}"
: "${RESTORE_COMPOSE_FILE:?Set the restore-only Compose file}"
: "${PRIVACY_RECOVERY_MEDIA_VOLUMES:?Set exact comma-separated Docker volume names for the three restored media roots}"
: "${HOST_WRITER_ISOLATION_GATE_EXECUTABLE:?Set an executable host-level process/mount isolation gate}"

if [[ ! "$RESTORE_COMPOSE_PROJECT" =~ ^vow-restore-[a-z0-9][a-z0-9-]*$ ]]; then
  echo "refusing non-dedicated Compose project; expected vow-restore-* name" >&2
  exit 1
fi
if [[ ! -f "$RESTORE_COMPOSE_FILE" || -L "$RESTORE_COMPOSE_FILE" ]]; then
  echo "restore Compose file must be a regular non-symlink file" >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required for fail-closed Docker mount inspection" >&2; exit 1; }
if [[ ! "$HOST_WRITER_ISOLATION_GATE_EXECUTABLE" = /* || ! -f "$HOST_WRITER_ISOLATION_GATE_EXECUTABLE" || -L "$HOST_WRITER_ISOLATION_GATE_EXECUTABLE" || ! -x "$HOST_WRITER_ISOLATION_GATE_EXECUTABLE" ]]; then
  echo "host writer-isolation gate must be an absolute, regular, executable, non-symlink file" >&2
  exit 1
fi

IFS=',' read -r -a media_volumes <<< "$PRIVACY_RECOVERY_MEDIA_VOLUMES"
if [[ "${#media_volumes[@]}" -ne 3 ]]; then
  echo "exactly three private media volume names are required" >&2
  exit 1
fi
for volume in "${media_volumes[@]}"; do
  if [[ ! "$volume" =~ ^${RESTORE_COMPOSE_PROJECT}_(private_photos|private_voice_intros|private_identity_l3)$ ]]; then
    echo "media volume is not one of the three project-scoped restore volumes" >&2
    exit 1
  fi
done
if [[ "$(printf '%s\n' "${media_volumes[@]}" | sort -u | wc -l | tr -d ' ')" -ne 3 ]]; then
  echo "duplicate private media volume names are not allowed" >&2
  exit 1
fi

compose=(docker compose --profile '*' -p "$RESTORE_COMPOSE_PROJECT" -f "$RESTORE_COMPOSE_FILE")
services_output="$("${compose[@]}" config --services)"
mapfile -t services <<< "$services_output"
if [[ -z "$services_output" || "${#services[@]}" -eq 0 ]]; then
  echo "restore Compose project has no services" >&2
  exit 1
fi
if ! printf '%s\n' "${services[@]}" | grep -qx 'db'; then
  echo "restore Compose project must contain the dedicated db service" >&2
  exit 1
fi

# Stop every service in this dedicated restore project except its isolated DB.
# Never run this script against the normal Vow Compose project.
writers=()
for service in "${services[@]}"; do
  [[ "$service" == "db" ]] || writers+=("$service")
done
if [[ "${#writers[@]}" -gt 0 ]]; then
  "${compose[@]}" stop "${writers[@]}"
fi

# Verify no running container anywhere on this Docker daemon has a writable
# attachment to any of the exact restore media volumes. Read-only verifier
# attachments are permitted; containers outside this restore project are never
# stopped automatically.
running_output="$(docker ps -q)"
mapfile -t running_containers <<< "$running_output"
if [[ -z "$running_output" ]]; then
  running_containers=()
fi
for container in "${running_containers[@]}"; do
  inspect="$(docker inspect "$container")"
  for volume in "${media_volumes[@]}"; do
    if jq -e --arg volume "$volume" '
      .[0].Mounts[]? | select(.Type == "volume" and .Name == $volume and .RW == true)
    ' <<< "$inspect" >/dev/null; then
      echo "writable private-media volume attachment remains: container=$container volume=$volume" >&2
      exit 1
    else
      jq_status=$?
      if [[ "$jq_status" -ne 1 ]]; then
        echo "Docker mount inspection failed; refusing to continue" >&2
        exit 1
      fi
    fi
  done
done

# Confirm the only running service in this project is the dedicated DB.
project_output="$(docker ps -q --filter "label=com.docker.compose.project=$RESTORE_COMPOSE_PROJECT")"
mapfile -t project_containers <<< "$project_output"
if [[ -z "$project_output" ]]; then
  project_containers=()
fi
if [[ "${#project_containers[@]}" -ne 1 ]]; then
  echo "expected exactly one running restore database container" >&2
  exit 1
fi
for container in "${project_containers[@]}"; do
  service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container")"
  if [[ "$service" != "db" ]]; then
    echo "unexpected running restore-project service remains: $service" >&2
    exit 1
  fi
done

# Docker cannot prove host process isolation. Require a separate executable gate and fail closed if it rejects.
"$HOST_WRITER_ISOLATION_GATE_EXECUTABLE"
printf 'Docker and host writer isolation gates passed for restore project %s.\n' "$RESTORE_COMPOSE_PROJECT"
