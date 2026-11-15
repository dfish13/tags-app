#!/usr/bin/env bash
#
# Build the folder the static server serves: symlinks to the handful of files
# the browser needs, and nothing else.
#
#   scripts/link-public.sh ~/tags-app-public
#   cd ~/tags-app-public && python3 -m http.server 8080 --bind 127.0.0.1
#
# Never serve the checkout itself. A static server publishes every file under
# its directory, and the checkout holds .env (database password, admin emails),
# .git/ and the backend source. This is an allowlist so that a new file stays
# private until someone decides it is public.
#
# The links point into the checkout, so a `git pull` still ships the frontend
# with no copy step. Re-run this after pulling a change that adds a public file.
# Safe to re-run: it replaces its own links and removes none.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Every deployment needs these.
PUBLIC=(index.html sw.js icon-192.png icon-512.png apple-touch-icon.png)
# Per-deployment, and fine to be missing: the page falls back without them.
OPTIONAL=(tag-logo-128.png course-art)

dest="${1:-}"
if [ -z "$dest" ]; then
  echo "usage: scripts/link-public.sh <dir-to-serve>" >&2
  exit 1
fi
dest="$(realpath -m "$dest")"
case "$dest/" in
  "$REPO_ROOT"/*)
    echo "refusing: $dest is inside the checkout, which is what this avoids" >&2
    exit 1 ;;
esac
mkdir -p "$dest"

for f in "${PUBLIC[@]}"; do
  if [ ! -e "$REPO_ROOT/$f" ]; then
    echo "missing $f in $REPO_ROOT" >&2
    exit 1
  fi
  ln -sfn "$REPO_ROOT/$f" "$dest/$f"
done
for f in "${OPTIONAL[@]}"; do
  if [ -e "$REPO_ROOT/$f" ]; then ln -sfn "$REPO_ROOT/$f" "$dest/$f"; fi
done

echo "serving set in $dest:"
ls -1 "$dest"
