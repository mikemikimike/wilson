#!/usr/bin/env bash
# Stop the local SonarQube. --purge also removes container, volumes, networks and token state.
set -euo pipefail
cd "$(dirname "$0")"; . ./common.sh
docker stop "$SONAR_NAME" >/dev/null 2>&1 || true
if [ "${1:-}" = "--purge" ]; then
  docker rm -f "$SONAR_NAME" >/dev/null 2>&1 || true
  for v in "${SONAR_VOLUMES[@]}"; do docker volume rm "$v" >/dev/null 2>&1 || true; done
  docker network rm "$SONAR_NET_INT" "$SONAR_NET_PUB" >/dev/null 2>&1 || true
  rm -rf "$SONAR_STATE"
  echo "purged"
else
  echo "stopped (data kept in volumes; use --purge to delete)"
fi
