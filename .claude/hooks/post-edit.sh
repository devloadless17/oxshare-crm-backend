#!/usr/bin/env bash
#
# PostToolUse(Edit|Write) — blocking.
#
# Hands a lint/format failure back to the model the moment it happens, instead of
# letting it pile up until CI. This is the layer that makes the project's coding
# standards non-optional rather than aspirational.
#
# Hook contract:
#   exit 0  = silent pass
#   exit 2  = blocking error; stderr is shown to Claude, which must fix it
#   other   = hook malfunction, NOT fed back to the model
# So every internal failure below must funnel into exit 2 or exit 0, never 1.
#
# TWIN FILE — an identical copy lives at the same path in the sibling repos.
set -uo pipefail

payload="$(cat)"

# jq is the only external dependency. Without it we cannot find the edited file,
# and a hook that silently passes is worse than one that says why it cannot run.
if ! command -v jq >/dev/null 2>&1; then
  echo "post-edit hook: jq is not installed, so the lint gate cannot run. Install jq." >&2
  exit 2
fi

file="$(printf '%s' "$payload" | jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)"
[ -n "$file" ] || exit 0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The edit may have landed in a sibling repo; that repo's own hook owns it.
case "$file" in
  "$repo_root"/*) ;;
  *) exit 0 ;;
esac

if out="$("$repo_root/scripts/gate-file.sh" "$file" 2>&1)"; then
  exit 0
fi

{
  echo "Lint gate failed on ${file#"$repo_root"/} — fix this before moving on."
  echo "(prettier and eslint --fix already ran; what remains needs a decision.)"
  echo
  printf '%s\n' "$out"
} >&2
exit 2
