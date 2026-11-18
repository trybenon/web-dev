#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

image=${1:?Usage: deploy.sh IMAGE SHA COMPOSE_FILE [STATE_DIRECTORY] [HEALTH_URL] [MONITORING_ENV]}
sha=${2:?Missing commit SHA}
source_compose=${3:?Missing Compose file}
state_dir=${4:-/opt/watch-together-deploy}
health_url=${5:-https://krozmo.online/api/health}
source_monitoring=${6:-}
if [[ -n "$source_monitoring" ]]; then source_monitoring=$(realpath "$source_monitoring"); fi
source_script=$(realpath "${BASH_SOURCE[0]}")
source_compose=$(realpath "$source_compose")

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
if [[ "$image" != ghcr.io/*:"$sha" && ! "$image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Expected a GHCR image tagged with the commit SHA or a local image ID" >&2
  exit 1
fi
for tool in docker curl python3 flock; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
done
mkdir -p "$state_dir"
cd "$state_dir"
exec 9>.deploy.lock
flock -w 300 9

backup=$(mktemp -d "$state_dir/.transaction.XXXXXX")
cp "$source_compose" "$backup/candidate.yml"
cp "$source_script" "$backup/deploy.sh"
changed=0
switched=0
legacy_stopped=0
legacy_moved=0
legacy_backup=
old_image=
old_sha=
had_compose=0
had_env=0
had_monitoring=0
[[ ! -f compose.yml ]] || { cp compose.yml "$backup/compose.yml"; had_compose=1; }
[[ ! -f .env ]] || { cp .env "$backup/.env"; had_env=1; }
[[ ! -f monitoring.env ]] || { cp monitoring.env "$backup/monitoring.env"; had_monitoring=1; }
if [[ -n "$source_monitoring" ]]; then cp "$source_monitoring" "$backup/candidate-monitoring.env"; fi

compose() {
  # Ignore exported image variables: the transaction owns the version in .env.
  env -u APP_IMAGE -u APP_SHA docker compose --project-name watch-together --env-file .env -f compose.yml "$@"
}

check_health() {
  local url=$1 expected=$2 attempts=${3:-12}
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl --fail --silent --show-error --max-time 10 \
      --header 'Cache-Control: no-cache' "$url?deploy=$sha-$attempt" |
      python3 -c 'import json,sys; b=json.load(sys.stdin); sys.exit(0 if b.get("status")=="ok" and (not sys.argv[1] or b.get("sha")==sys.argv[1]) else 1)' "$expected"; then
      return 0
    fi
    if (( attempt < attempts )); then sleep 5; fi
  done
  return 1
}

finish() {
  local result=$? rollback_result=0
  trap - EXIT
  set +e
  if (( result != 0 && changed )); then
    echo "Deploy failed; restoring previous application" >&2
    compose logs --tail 60 --no-color app >&2
    if (( had_monitoring )); then cp "$backup/monitoring.env" monitoring.env; else rm -f monitoring.env; fi
    if (( legacy_moved )); then
      compose rm --stop --force app &&
        docker rename "$legacy_backup" watch-together-web &&
        docker start watch-together-web &&
        check_health http://127.0.0.1:18080/api/health "" 6
      rollback_result=$?
    elif (( legacy_stopped )); then
      docker start watch-together-web
      rollback_result=$?
    elif (( switched )) && [[ -n "$old_image" ]]; then
      cp "$backup/compose.yml" compose.yml &&
        printf 'APP_IMAGE=%s\nAPP_SHA=%s\n' "$old_image" "$old_sha" > .env &&
        compose up --detach --no-build --pull never --wait --wait-timeout 90 app &&
        check_health "$health_url" "$old_sha" 6
      rollback_result=$?
    elif (( switched )); then
      compose rm --stop --force app
      rollback_result=$?
    fi
    if (( had_compose )); then cp "$backup/compose.yml" compose.yml; else rm -f compose.yml; fi
    if (( had_env )); then cp "$backup/.env" .env; else rm -f .env; fi
    if (( rollback_result )); then
      echo "ROLLBACK FAILED; inspect watch-together-web immediately" >&2
    else
      echo "Previous state restored" >&2
    fi
  fi
  rm -rf "$backup"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Download before interrupting the running application. Registry failures cause no downtime.
if [[ "$image" == ghcr.io/* ]]; then
  APP_IMAGE="$image" docker compose --project-name watch-together --env-file /dev/null -f "$source_compose" pull app
else
  docker image inspect "$image" >/dev/null
fi
docker network inspect watch-together-net >/dev/null

if docker container inspect watch-together-web >/dev/null 2>&1; then
  old_image=$(docker inspect --format '{{.Image}}' watch-together-web)
  old_sha=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' watch-together-web | sed -n 's/^APP_RELEASE=//p')
  project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' watch-together-web)
  if [[ "$project" == watch-together ]]; then
    (( had_compose && had_env )) || { echo "Missing managed deployment state" >&2; exit 1; }
  elif [[ -z "$project" || "$project" == '<no value>' ]]; then
    # First deployment: retain the manually started container with its complete configuration.
    legacy_backup="watch-together-web-before-autodeploy-$(date +%s)"
  else
    echo "Container belongs to a different Compose project: $project" >&2
    exit 1
  fi
fi

changed=1
cp "$backup/candidate.yml" compose.yml
printf 'APP_IMAGE=%s\nAPP_SHA=%s\n' "$image" "$sha" > .env
if [[ -n "$source_monitoring" ]]; then cp "$backup/candidate-monitoring.env" monitoring.env; fi
compose config --quiet
if [[ -n "$legacy_backup" ]]; then
  legacy_stopped=1
  docker stop watch-together-web
  docker rename watch-together-web "$legacy_backup"
  legacy_moved=1
fi
switched=1
compose up --detach --no-build --pull never --wait --wait-timeout 90 app
check_health http://127.0.0.1:18080/api/health "$sha" 3
check_health "$health_url" "$sha"

if [[ -n "$old_image" && -z "$legacy_backup" ]]; then
  cp "$backup/compose.yml" previous-compose.yml
  printf 'APP_IMAGE=%s\nAPP_SHA=%s\n' "$old_image" "$old_sha" > previous.env
  if (( had_monitoring )); then cp "$backup/monitoring.env" previous-monitoring.env; else : > previous-monitoring.env; fi
fi
cp "$backup/deploy.sh" deploy.sh
changed=0
echo "Deployed $sha; public health SHA matches"
if [[ -n "$legacy_backup" ]]; then
  echo "Original container retained (stopped): $legacy_backup"
fi
