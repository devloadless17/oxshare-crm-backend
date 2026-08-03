#!/usr/bin/env bash
#
# Stop — blocking. The last thing between "I'm done" and a red CI.
#
# Runs the same gates CI runs, so "done" cannot mean "done except the parts a
# machine checks".
#
# TWIN FILE — an identical copy lives at the same path in the sibling repos.
set -uo pipefail

payload="$(cat)"

# Non-negotiable: without this the hook re-fires on the continuation it caused
# and the session never ends.
if command -v jq >/dev/null 2>&1; then
  active="$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null)"
  [ "$active" = "true" ] && exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root" || exit 0

# Nothing changed in this repo — nothing to verify. Also covers the case where
# Claude was working in a sibling repo entirely.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git diff --quiet HEAD -- 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    exit 0
  fi
fi

repo_name="$(node -p "require('./package.json').name" 2>/dev/null || echo unknown)"

report=""
fail=0

run_gate() {
  local script="$1"
  local out
  if ! out="$(npm run -s "$script" 2>&1)"; then
    fail=1
    report+="--- npm run $script ---"$'\n'"$out"$'\n\n'
  fi
}

run_gate type-check
run_gate lint
run_gate format:check

# Unit tests only where they are seconds rather than minutes. The backend suite is
# Testcontainers with fileParallelism:false and takes minutes BY DESIGN — the money
# tests must observe each other's concurrency. That belongs in CI, not in the path
# of every "done".
if [ "$repo_name" != "backend" ]; then
  run_gate test
fi

[ "$fail" -eq 0 ] && exit 0

{
  echo "Not done yet — the $repo_name gate is red:"
  echo
  printf '%s\n' "$report"
  if [ "$repo_name" = "backend" ]; then
    echo "Note: the money test suite is not run here. Run 'npm test' before committing."
  fi
} >&2
exit 2
