#!/usr/bin/env bash
#
# The image's CONTENT KEY: a hash of every tracked file the build can depend on,
# i.e. the commit's tree minus exactly the paths ci.yml's `paths-ignore` skips.
#
# Two commits with the same code get the same key whatever their history (a
# "Release:" merge commit on production and the main commit it came from), and a
# docs-only change keeps it, so it never waits for a main build that paths-ignore
# skipped. Keep the filter below in step with `paths-ignore` in ci.yml.
#
#   bash .github/content-key.sh [<commit>]     (default HEAD)
set -euo pipefail
git ls-tree -r "${1:-HEAD}" \
  | awk -F'\t' '$2 !~ /\.md$/ && $2 !~ /^docs\// && $2 != ".gitignore" && $2 != "LICENSE" && $2 !~ /^\.vscode\//' \
  | sha256sum | cut -c1-32
