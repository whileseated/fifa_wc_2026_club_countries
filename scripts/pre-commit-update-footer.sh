#!/usr/bin/env bash
# Hook entrypoint: refresh the footer timestamp data and stage it.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ ! -x "scripts/generate-timestamps.sh" ]; then
  echo "pre-commit: scripts/generate-timestamps.sh is missing or not executable" >&2
  exit 1
fi

scripts/generate-timestamps.sh >/dev/null
git add includes/file-timestamps.json
