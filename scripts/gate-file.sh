#!/usr/bin/env bash
#
# The single definition of "this file is acceptable".
#
# Called by three things, which must never disagree about the answer:
#   - .claude/hooks/post-edit.sh   (Claude Code PostToolUse, blocking)
#   - lint-staged                  (pre-commit)
#   - a human, by hand
#
# Rewrites the file in place (prettier --write, eslint --fix) and exits non-zero
# only for what a machine cannot fix on its own.
#
# TWIN FILE — an identical copy lives at the same path in the sibling repos.
# The only per-repo difference is the file extensions matched below.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

# Claude Code hooks run in a non-login shell where nvm has never been sourced, so
# `npx` below is absent and both calls fail. That set rc=1, and post-edit.sh then
# blocked the edit with "Lint gate failed ... what remains needs a decision" — a
# specific, confident, entirely false claim. See scripts/lib/node-path.sh.
# shellcheck source=lib/node-path.sh
. "$repo_root/scripts/lib/node-path.sh"
if [ "$NODE_PATH_RESOLVED" -ne 1 ]; then
  echo "gate-file.sh: node/npm not found on PATH — prettier and eslint did NOT run." >&2
  echo "This is an environment problem, not a lint error. See scripts/lib/node-path.sh." >&2
  exit 1
fi

files=()
for f in "$@"; do
  case "$f" in
    *.ts | *.mts | *.cts) ;;  # no .tsx in the API
    *) continue ;;
  esac
  # Generated, vendored or build output is never our problem. Drizzle migrations
  # in particular must never be hand-edited (see CLAUDE.md), and reformatting
  # them is the same mistake with extra steps.
  case "$f" in
    */database/migrations/* | */dist/* | */node_modules/* | */coverage/*)
      continue
      ;;
  esac
  [ -f "$f" ] && files+=("$f")
done

[ "${#files[@]}" -eq 0 ] && exit 0

rc=0
# --no-install: never silently pull a package from the network mid-edit.
npx --no-install prettier --write --log-level warn -- "${files[@]}" || rc=1
# --fix first, so the caller is never handed a failure it could not have avoided.
# The exit status of this second pass is the report. eslint exits non-zero for
# errors only; the project-wide warning ceiling is enforced by `npm run lint`.
npx --no-install eslint --fix -- "${files[@]}" || rc=1

exit $rc
