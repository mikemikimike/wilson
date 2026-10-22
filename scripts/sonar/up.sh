#!/usr/bin/env bash
# Start a LOCAL SonarQube Community server (127.0.0.1 only, telemetry off), create project + token.
set -euo pipefail
cd "$(dirname "$0")"; . ./common.sh
PROJECT_KEY="${PROJECT_KEY:-wilson-cli}"
mkdir -p "$SONAR_STATE"; chmod 700 "$SONAR_STATE"

docker network inspect "$SONAR_NET_PUB" >/dev/null 2>&1 || docker network create "$SONAR_NET_PUB" >/dev/null
docker network inspect "$SONAR_NET_INT" >/dev/null 2>&1 || docker network create --internal "$SONAR_NET_INT" >/dev/null
for v in "${SONAR_VOLUMES[@]}"; do docker volume inspect "$v" >/dev/null 2>&1 || docker volume create "$v" >/dev/null; done

if docker ps -a --format '{{.Names}}' | grep -qx "$SONAR_NAME"; then
  docker start "$SONAR_NAME" >/dev/null
else
  # SONAR_TELEMETRY_ENABLE=false  == sonar.telemetry.enable=false (documented property; verified in README).
  # Heaps are capped small on purpose: the Docker Desktop VM is only 8 GB and the (amd64, Rosetta) scanner's Node bridge
  # needs ~1.5 GB; with default heaps the VM OOM-killed the bridge mid-scan (hit on 2026-10-22).
  # disk watermark off: a nearly-full Docker VM disk otherwise makes ES read-only and boot fail (hit on 2026-10-22).
  # mmap off: Docker Desktop on macOS cannot raise vm.max_map_count for the embedded Elasticsearch.
  docker run -d --name "$SONAR_NAME" \
    --network "$SONAR_NET_PUB" \
    -p "127.0.0.1:${SONAR_PORT}:9000" \
    -v "${SONAR_VOLUMES[0]}:/opt/sonarqube/data" \
    -v "${SONAR_VOLUMES[1]}:/opt/sonarqube/extensions" \
    -v "${SONAR_VOLUMES[2]}:/opt/sonarqube/logs" \
    -e SONAR_TELEMETRY_ENABLE=false \
    -e SONAR_UPDATECENTER_ACTIVATE=false \
    -e SONAR_WEB_JAVAOPTS="-Xmx512m -Xms128m" -e SONAR_CE_JAVAOPTS="-Xmx512m -Xms128m" \
    -e SONAR_SEARCH_JAVAOPTS="-Xmx256m -Xms256m" \
    -e SONAR_SEARCH_JAVAADDITIONALOPTS="-Dnode.store.allow_mmap=false -Dcluster.routing.allocation.disk.threshold_enabled=false" \
    --memory 2g \
    "$SONAR_SERVER_IMAGE" >/dev/null
  docker network connect "$SONAR_NET_INT" "$SONAR_NAME"
fi

printf 'waiting for UP'
for _ in $(seq 1 90); do
  st=$(curl -fsS "$SONAR_URL/api/system/status" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])' 2>/dev/null || true)
  [ "$st" = "UP" ] && break
  printf '.'; sleep 4
done
echo; [ "${st:-}" = "UP" ] || { docker logs --tail 40 "$SONAR_NAME" >&2; die "server did not reach UP"; }

PASS_FILE="$SONAR_STATE/admin-password"; TOKEN_FILE="$SONAR_STATE/token"
if [ ! -s "$PASS_FILE" ]; then
  NEWPASS="$(python3 -c 'import secrets;print(secrets.token_urlsafe(18)+"Aa1!")')"
  # first boot only: admin/admin -> random password
  if curl -fsS -u admin:admin -X POST "$SONAR_URL/api/users/change_password" \
       --data-urlencode login=admin --data-urlencode previousPassword=admin --data-urlencode "password=$NEWPASS" >/dev/null; then
    (umask 077; printf %s "$NEWPASS" > "$PASS_FILE")
  else
    die "admin password already changed but $PASS_FILE missing; run down.sh --purge and up.sh again"
  fi
fi
PASS="$(cat "$PASS_FILE")"
if [ ! -s "$TOKEN_FILE" ]; then
  curl -fsS -u "admin:$PASS" -X POST "$SONAR_URL/api/user_tokens/revoke" --data-urlencode name=wilson-scan >/dev/null 2>&1 || true
  TOK="$(curl -fsS -u "admin:$PASS" -X POST "$SONAR_URL/api/user_tokens/generate" --data-urlencode name=wilson-scan --data-urlencode type=GLOBAL_ANALYSIS_TOKEN \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
  (umask 077; printf %s "$TOK" > "$TOKEN_FILE")
fi
# project is created lazily by scan.sh per key (create here for the default one)
curl -fsS -u "admin:$PASS" -X POST "$SONAR_URL/api/projects/create" --data-urlencode "project=$PROJECT_KEY" --data-urlencode "name=$PROJECT_KEY" >/dev/null 2>&1 || true
echo "SonarQube UP at $SONAR_URL (127.0.0.1 only). state: $SONAR_STATE (admin-password, token; mode 600)"
