#!/usr/bin/env bash
# Post-deployment smoke test. Usage:
#   ./scripts/smoke-test.sh http://127.0.0.1:8090
#   SMOKE_EMAIL=admin@... SMOKE_PASSWORD=... ./scripts/smoke-test.sh https://smarthouse.example.com
set -euo pipefail
BASE="${1:-http://127.0.0.1:8090}"
fail() { echo "FAIL: $*"; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(code "$BASE/api/health")" = 200 ] || fail "health endpoint"
echo "ok  health"
curl -fsS "$BASE/" | grep -q '<div id="root">' || fail "SPA not served"
echo "ok  web app served"
[ "$(code "$BASE/api/projects")" = 401 ] || fail "API must require login"
echo "ok  API requires authentication"

if [ -n "${SMOKE_EMAIL:-}" ] && [ -n "${SMOKE_PASSWORD:-}" ]; then
  JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
  LOGIN=$(curl -fsS -c "$JAR" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\"}" "$BASE/api/auth/login") || fail "login"
  echo "ok  login"
  PROJECTS=$(curl -fsS -b "$JAR" "$BASE/api/projects") || fail "list projects"
  echo "$PROJECTS" | grep -q 'PIN 70153699' || fail "PIN 70153699 missing"
  echo "$PROJECTS" | grep -q 'PIN 70153016' || fail "PIN 70153016 missing"
  echo "ok  both project codes present"
  CSRF=$(echo "$LOGIN" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
  curl -fsS -b "$JAR" -X POST -H "X-CSRF-Token: $CSRF" "$BASE/api/auth/logout" >/dev/null
fi
echo "Smoke test passed for $BASE"
