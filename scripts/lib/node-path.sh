#!/usr/bin/env bash
#
# Put node and npm on PATH. Source this; do not execute it.
#
#   . "$repo_root/scripts/lib/node-path.sh"
#
# Why this exists: Claude Code hooks run in a NON-LOGIN, non-interactive shell.
# A version manager that installs itself from ~/.zshrc or ~/.bashrc has therefore
# never run, and `npm` is simply absent. Every gate then fails with
# "npm: command not found" — a red gate that says nothing about the code.
#
# That is the worse half. The quieter half is that a gate which fails for
# environmental reasons gets read as noise, and a gate people learn to ignore has
# stopped being a gate. Both real failures below were of that shape:
#
#   - pre-stop.sh reported all four gates red with "command not found", while the
#     repo was in fact green.
#   - gate-file.sh's `npx --no-install prettier` failed the same way, so
#     post-edit.sh blocked the edit with "Lint gate failed ... what remains needs
#     a decision" — which is a confident, specific, and entirely false claim.
#
# Deliberately NOT `source ~/.nvm/nvm.sh`: that costs ~250ms of shell parsing on
# every single edit, and this runs per-PostToolUse. We only need the bin
# directory on PATH, not nvm's function API.
#
# TWIN FILE — an identical copy lives at the same path in the sibling repos.

# Already resolvable (lint-staged, or a human in a normal shell) — nothing to do.
if ! command -v npm >/dev/null 2>&1; then
  _nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  _candidates=()

  # 1. An active nvm sets this directly.
  [ -n "${NVM_BIN:-}" ] && _candidates+=("$NVM_BIN")

  # 2. nvm's `default` alias — what this user's interactive shell would pick.
  #    Preferred over "newest installed", which may be a version they installed
  #    to test something and never selected.
  if [ -r "$_nvm_dir/alias/default" ]; then
    _default="$(cat "$_nvm_dir/alias/default" 2>/dev/null)"
    case "$_default" in
      v*) _candidates+=("$_nvm_dir/versions/node/$_default/bin") ;;
      [0-9]*) _candidates+=("$_nvm_dir/versions/node/v$_default/bin") ;;
    esac
  fi

  # 3. Newest installed nvm version. sort -V so v10 sorts above v9.
  while IFS= read -r _dir; do
    [ -n "$_dir" ] && _candidates+=("$_dir")
  done < <(ls -d "$_nvm_dir"/versions/node/*/bin 2>/dev/null | sort -V | tac)

  # 4. System installs (Homebrew on both architectures, Linux packages, asdf,
  #    Volta). Last, because a repo pinned to an nvm version should get it.
  _candidates+=(
    /opt/homebrew/bin
    /usr/local/bin
    /usr/bin
    "$HOME/.asdf/shims"
    "$HOME/.volta/bin"
  )

  for _candidate in "${_candidates[@]}"; do
    if [ -n "$_candidate" ] && [ -x "$_candidate/npm" ]; then
      PATH="$_candidate:$PATH"
      export PATH
      break
    fi
  done

  unset _nvm_dir _default _dir _candidate _candidates
fi

# Callers check this rather than assuming success. Reporting "I could not run the
# gate" is honest; reporting a lint failure that never happened is not.
if command -v npm >/dev/null 2>&1; then
  NODE_PATH_RESOLVED=1
else
  NODE_PATH_RESOLVED=0
fi
export NODE_PATH_RESOLVED
