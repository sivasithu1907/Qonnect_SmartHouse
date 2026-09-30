#!/usr/bin/env bash
# Read-only pre-deployment checks for THIS stack (uses ./.env). Changes nothing.
#   ./scripts/preflight.sh            # first install: port must be free
#   ./scripts/preflight.sh --update   # re-deploy: port may be held by this same stack
set -uo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-}"
ERR=0
ok()   { echo "ok    $*"; }
warn() { echo "WARN  $*"; }
bad()  { echo "FAIL  $*"; ERR=1; }

command -v docker >/dev/null || { bad "docker not installed"; exit 1; }
docker compose version >/dev/null 2>&1 && ok "$(docker compose version | head -1)" || bad "docker compose plugin missing"

[ -f .env ] || { bad ".env not found (copy deploy/staging.env.example or deploy/production.env.example)"; exit 1; }
PERM=$(stat -c '%a' .env 2>/dev/null || echo "?")
[ "$PERM" = "600" ] && ok ".env permissions 600" || warn ".env permissions are $PERM — run: chmod 600 .env"
git check-ignore -q .env 2>/dev/null && ok ".env is git-ignored" || warn ".env is not git-ignored"

# read values without executing the file
val() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
NAME=$(val COMPOSE_PROJECT_NAME); PORT=$(val APP_PORT); BIND=$(val APP_BIND); PW=$(val POSTGRES_PASSWORD)
[ -n "$NAME" ] && ok "COMPOSE_PROJECT_NAME=$NAME" || bad "COMPOSE_PROJECT_NAME is empty"
[ -n "$PORT" ] || bad "APP_PORT is empty"
[ "${BIND:-127.0.0.1}" = "127.0.0.1" ] && ok "APP_BIND=127.0.0.1 (not publicly exposed)" || warn "APP_BIND=$BIND — the app port is reachable beyond localhost"

if [ -z "$PW" ]; then bad "POSTGRES_PASSWORD is empty — generate with: openssl rand -hex 32"
elif [[ "$PW" == *CHANGE_ME* ]]; then bad "POSTGRES_PASSWORD is still the placeholder"
elif [[ "$PW" =~ [\$\'\"\`[:space:]] ]]; then bad "POSTGRES_PASSWORD contains \$, quotes or spaces — regenerate with: openssl rand -hex 32"
elif [ ${#PW} -lt 32 ]; then warn "POSTGRES_PASSWORD is shorter than 32 characters"
else ok "POSTGRES_PASSWORD set (${#PW} chars, not shown)"; fi

# Is the port free?
OURS=$(docker ps -q --filter "label=com.docker.compose.project=$NAME" --filter "publish=$PORT" 2>/dev/null)
listening() {  # prints something if any process listens on TCP port $1 (IPv4 or IPv6)
  if command -v ss >/dev/null; then ss -ltnH "( sport = :$1 )" 2>/dev/null
  elif command -v lsof >/dev/null && [ "$(id -u)" = 0 ]; then lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2
  else local hex; hex=$(printf '%04X' "$1"); awk -v h=":$hex" '$4=="0A" && substr($2, length($2)-4)==h {print "listening " $2}' /proc/net/tcp /proc/net/tcp6 2>/dev/null
  fi
}
LISTEN=$(listening "$PORT")
OTHER=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -E "[:]$PORT->" | grep -v -F "$NAME-" || true)
if [ -n "$OTHER" ]; then bad "port $PORT is published by another container: $OTHER"
elif [ -n "$LISTEN" ] && [ -z "$OURS" ]; then bad "port $PORT is already in use on this host ($LISTEN)"
elif [ -n "$OURS" ]; then [ "$MODE" = "--update" ] && ok "port $PORT is used by this stack ($NAME) — expected for an update" || warn "port $PORT is already used by this stack ($NAME); use --update for re-deploys"
else ok "port $PORT is free"; fi

# Existing resources for this project name
C=$(docker ps -a -q --filter "label=com.docker.compose.project=$NAME" | wc -l)
V=$(docker volume ls -q --filter "name=^${NAME}_" | wc -l)
if [ "$C" -gt 0 ] || [ "$V" -gt 0 ]; then
  [ "$MODE" = "--update" ] && ok "existing $NAME stack found ($C containers, $V volumes)" \
    || warn "$NAME already has $C containers / $V volumes — this looks like a re-deploy (use --update)"
else ok "no existing resources named $NAME (fresh install)"; fi

echo "Other Compose projects on this host (left untouched):"
docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | grep -v -x -F "$NAME" | grep -v '^$' | sed 's/^/      - /' || true

AVAIL=$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')
[ -n "$AVAIL" ] && { [ "$AVAIL" -gt 3000 ] && ok "disk free for Docker: ${AVAIL} MB" || warn "only ${AVAIL} MB free for Docker"; }

[ $ERR -eq 0 ] && echo "Preflight passed." || echo "Preflight FAILED — fix the items above before starting the stack."
exit $ERR
