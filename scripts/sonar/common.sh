#!/usr/bin/env bash
# Shared config for the local SonarQube pre-pass. Sourced, not executed.
# Pinned by tag AND digest (checked 2026-10-22).
SONAR_SERVER_IMAGE="sonarqube:26.10.0.133078-community@sha256:0b3408443fb6a311253de27941b10977c9b977fd53be2265947bfe14161308b8"
SONAR_SCANNER_IMAGE="sonarsource/sonar-scanner-cli:12.2.0.4256_8.1.0@sha256:a3f4215076706c95a17a68c19322ee916e40a3acd081a8c1a1e839e0194afa57"
SONAR_NAME="${SONAR_NAME:-wilson-sonar}"
SONAR_PORT="${SONAR_PORT:-9000}"
SONAR_URL="http://127.0.0.1:${SONAR_PORT}"
SONAR_STATE="${SONAR_STATE:-/private/tmp/claude-501/wilson-sonar}"   # token + admin password live ONLY here (never in git)
SONAR_VOLUMES=("${SONAR_NAME}-data" "${SONAR_NAME}-extensions" "${SONAR_NAME}-logs")
SONAR_NET_PUB="${SONAR_NAME}-net"            # server <-> host publish (127.0.0.1 only)
SONAR_NET_INT="${SONAR_NAME}-internal"       # --internal: scanner has NO route to the internet
die() { echo "sonar: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker not found"
command -v curl >/dev/null || die "curl not found"
command -v python3 >/dev/null || die "python3 not found"
