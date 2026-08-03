#!/usr/bin/env bash
#
# PostToolUse(Edit|Write) — asyncRewake, NOT blocking.
#
# Why async: the project typecheck is only ~1.6s warm, but adding that to every
# single edit costs minutes across a large task, and a typecheck taken after edit
# 1 of a 6-edit change is usually red for reasons the next edit fixes. Blocking on
# it would train thrashing. asyncRewake runs it detached at ~zero added latency
# and wakes the model only when this exits 2.
#
# TWIN FILE — an identical copy lives at the same path in the sibling repos.
set -uo pipefail

cat >/dev/null # drain stdin; no field from the payload is needed

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if out="$("$repo_root/scripts/gate-project.sh" 2>&1)"; then
  exit 0
fi

{
  echo "tsc --noEmit is failing project-wide after that edit:"
  echo
  printf '%s\n' "$out" | head -40
} >&2
exit 2
