#!/usr/bin/env bash
#
# The local test stack: frontend + API + a throwaway database, on one port,
# loaded with the same fake dataset every time.
#
#   scripts/dev.sh up        # start everything and serve on :8123 (Ctrl-C to stop)
#   scripts/dev.sh up --keep # same, but don't reload the fixture
#   scripts/dev.sh reseed    # reset the data to the fixture, server keeps running
#   scripts/dev.sh status    # what's running
#   scripts/dev.sh down      # stop the server and destroy the database
#
# `up` reloads the fixture by default: every session starts from the same board,
# so a bug that only shows up after you've clicked around is reproducible.
#
# The database is a container of its own — NOT the app's compose stack (:5432,
# which on the Pi holds the league's real history) and NOT the test database
# (:55433, which `npm run test:db` truncates between cases). Three separate
# databases, none of which can clobber another. src/dev/config.ts enforces it.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=tags-app-dev-db
PG_IMAGE=postgres:16-alpine
PG_PORT=55434
PORT="${PORT:-8123}"

export DATABASE_URL="postgres://tags:dev@127.0.0.1:${PG_PORT}/tags_dev"
export PORT
export LEAGUE_NAME="${LEAGUE_NAME:-Dev Tags League}"

# node is installed but off PATH on this machine (no system node). Find it
# rather than making every command start with an export.
ensure_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  for dir in "$HOME"/.local/share/node-*/bin; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
      return 0
    fi
  done
  echo "node not found on PATH or in ~/.local/share/node-*/bin" >&2
  exit 1
}

db_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

db_up() {
  if db_running; then
    echo "dev db already up on 127.0.0.1:${PG_PORT}"
    return 0
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # No volume: the data lives in the container's writable layer, so `down`
  # really destroys it and a stale fixture can't outlive a schema change.
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER=tags \
    -e POSTGRES_PASSWORD=dev \
    -e POSTGRES_DB=tags_dev \
    -p "127.0.0.1:${PG_PORT}:5432" \
    "$PG_IMAGE" >/dev/null

  # pg_isready inside the container: proves the server accepts queries, not
  # just that the port is bound (and the host has no psql client).
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U tags -d tags_dev -q 2>/dev/null; then
      echo "dev db ready on 127.0.0.1:${PG_PORT}"
      return 0
    fi
    sleep 1
  done
  echo "dev db failed to become ready" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

npm_deps() {
  if [ ! -d "$REPO_ROOT/backend/node_modules" ]; then
    echo "installing backend deps..."
    (cd "$REPO_ROOT/backend" && npm install --silent)
  fi
}

migrate() {
  (cd "$REPO_ROOT/backend" && npm run --silent db:migrate >/dev/null)
  echo "migrations applied"
}

seed() {
  (cd "$REPO_ROOT/backend" && node_modules/.bin/tsx src/dev/fixture.ts)
}

case "${1:-}" in
  up)
    ensure_node
    npm_deps
    db_up
    migrate
    if [ "${2:-}" = "--keep" ]; then
      echo "keeping existing data (--keep)"
    else
      seed
    fi
    # exec so Ctrl-C and whatever supervises this script signal the server
    # directly instead of orphaning it.
    cd "$REPO_ROOT/backend"
    exec node_modules/.bin/tsx src/dev/server.ts
    ;;

  reseed)
    ensure_node
    if ! db_running; then
      echo "dev db is not running — start it with: scripts/dev.sh up" >&2
      exit 1
    fi
    migrate
    seed
    echo "reload the page to see it"
    ;;

  down)
    # Only ever matches this stack's own server process.
    pkill -f 'tsx src/dev/server.ts' >/dev/null 2>&1 || true
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "dev stack down (database destroyed)"
    ;;

  status)
    if db_running; then
      echo "db     up on 127.0.0.1:${PG_PORT} ($CONTAINER)"
    else
      echo "db     down"
    fi
    if pgrep -f 'tsx src/dev/server.ts' >/dev/null 2>&1; then
      echo "server up on http://127.0.0.1:${PORT}"
    else
      echo "server down"
    fi
    ;;

  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
