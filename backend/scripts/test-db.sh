#!/usr/bin/env bash
#
# Start/stop the throwaway Postgres the DB-backed tests run against.
#
# The tests themselves run locally under node; only the database lives in a
# container, because there is no Postgres on this host. It is published on
# 127.0.0.1:55433 — a deliberately odd port, loopback only — so it cannot
# collide with the app's compose stack on 5432 or with the other projects'
# Postgres containers on this machine. Its data lives in the container's own
# writable layer, so `down` destroys it completely; no volume is ever created.
#
#   bash scripts/test-db.sh up     # start and wait until it accepts queries
#   bash scripts/test-db.sh down   # destroy it
#
set -euo pipefail

DB=tags-app-test-db
PG_IMAGE=postgres:16-alpine
PORT=55433

case "${1:-}" in
  up)
    docker rm -f "$DB" >/dev/null 2>&1 || true
    docker run -d --name "$DB" \
      -e POSTGRES_USER=tags \
      -e POSTGRES_PASSWORD=test \
      -e POSTGRES_DB=tags_test \
      -p "127.0.0.1:${PORT}:5432" \
      "$PG_IMAGE" >/dev/null

    # pg_isready inside the container: the host has no postgres client, and it
    # also proves the server is up rather than just the port being bound.
    for _ in $(seq 1 60); do
      if docker exec "$DB" pg_isready -U tags -d tags_test -q 2>/dev/null; then
        echo "test db ready on 127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 1
    done
    echo "test db failed to become ready" >&2
    docker logs "$DB" >&2 || true
    exit 1
    ;;
  down)
    docker rm -f "$DB" >/dev/null 2>&1 || true
    echo "test db destroyed"
    ;;
  *)
    echo "usage: $0 {up|down}" >&2
    exit 2
    ;;
esac
