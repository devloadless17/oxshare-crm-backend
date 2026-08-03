#!/usr/bin/env bash
#
# Project-wide typecheck. Fast when warm (~1.6s), but it must not race.
#
# `npm run type-check`, your editor's TS server and this script would otherwise
# all write the same default incremental cache; two concurrent writers corrupt it
# into either a silent full rebuild or, worse, a stale pass. Hence a dedicated
# tsBuildInfoFile plus a lock.
#
# TWIN FILE — an identical copy lives at the same path in the sibling repos.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1
mkdir -p node_modules/.cache

run_tsc() {
  npx --no-install tsc -p tsconfig.json --noEmit \
    --incremental --tsBuildInfoFile node_modules/.cache/gate.tsbuildinfo
}

# flock exists on Linux/WSL but not macOS; degrade to an unlocked run rather
# than failing, since a missing lock is less bad than a missing typecheck.
if command -v flock >/dev/null 2>&1; then
  exec flock node_modules/.cache/gate.lock \
    bash -c "$(declare -f run_tsc); cd '$repo_root' && run_tsc"
fi

run_tsc
