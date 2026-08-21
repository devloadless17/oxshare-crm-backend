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

  # 5. Windows, via the Git Bash that Claude Code's Bash tool runs.
  #
  #    Every candidate above is a Unix path, so on a Windows host this loop found
  #    nothing and the gates reported "node/npm not found on PATH — the typecheck
  #    did NOT run." The node.js MSI installs to `C:\Program Files\nodejs` and
  #    does NOT add itself to the PATH of a non-login shell, which is exactly the
  #    shell hooks get.
  #
  #    `-x "$_candidate/npm"` works unchanged here: npm ships a POSIX `npm` shell
  #    script beside `npm.cmd`, and Git Bash marks it executable. No .exe/.cmd
  #    suffix handling is needed.
  #
  #    Every entry MUST be a POSIX path (/c/...), never a drive-letter one
  #    (C:/...). This is the trap that cost the first attempt at this block:
  #    `[ -x "C:/Program Files/nodejs/npm" ]` PASSES, because bash's file tests
  #    go through the Windows layer — so the loop below matches and breaks, and
  #    it all looks like it worked. But `:` is the PATH separator, so prepending
  #    that entry splits it into `C` and `/Program Files/nodejs`, neither of
  #    which exists, and `command -v npm` still finds nothing. The gate then
  #    reports the same "did NOT run" as before, from a candidate that appeared
  #    to match. cygpath (shipped with Git Bash) does the conversion properly;
  #    %PROGRAMFILES% and friends also arrive with backslashes, which it handles
  #    in the same pass.
  _win_dirs=()
  if command -v cygpath >/dev/null 2>&1; then
    [ -n "${PROGRAMFILES:-}" ] && _win_dirs+=("$(cygpath -u "$PROGRAMFILES")/nodejs")
    [ -n "${LOCALAPPDATA:-}" ] && _win_dirs+=("$(cygpath -u "$LOCALAPPDATA")/Programs/nodejs")
    [ -n "${APPDATA:-}" ] && _win_dirs+=("$(cygpath -u "$APPDATA")/npm")
  fi
  # Fallback for a shell without cygpath, or one exporting none of the above.
  _win_dirs+=(
    "/c/Program Files/nodejs"
    "/c/Program Files (x86)/nodejs"
  )
  _candidates+=("${_win_dirs[@]}")

  for _candidate in "${_candidates[@]}"; do
    if [ -n "$_candidate" ] && [ -x "$_candidate/npm" ]; then
      PATH="$_candidate:$PATH"
      export PATH
      break
    fi
  done

  unset _nvm_dir _default _dir _candidate _candidates _win_dirs
fi

# Callers check this rather than assuming success. Reporting "I could not run the
# gate" is honest; reporting a lint failure that never happened is not.
if command -v npm >/dev/null 2>&1; then
  NODE_PATH_RESOLVED=1
else
  NODE_PATH_RESOLVED=0
fi
export NODE_PATH_RESOLVED
