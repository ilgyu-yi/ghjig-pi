#!/usr/bin/env bash
# .githooks/_lib.sh — shared prelude for the local git-hook enforcement tier.
# Every adapter (pre-commit / pre-push / commit-msg) sources this FIRST. It
# loads the per-clone shell adapter and exposes:
#   githook_source <helper.sh> [category] — safe_source a helper by basename.
#   githook_block  <category> <message>   — stderr message + best-effort
#                                            audit_log, returns non-zero.
# A missing adapter → exit 0: this is an ADVICE tier (folds to --no-verify
# by design), so an unregistered clone must NEVER have its git wedged.
#
# Delegation contract: <repo-top>/.ghjig/shell-adapter.sh is per-clone,
# UNTRACKED state, written when the clone registers with a dev shell. All
# knowledge of that shell's LOCATION and runtime interface lives in the
# adapter, never in this committed file. On sourcing, the adapter must
# provide: the functions `safe_source` and `audit_log`, and
# GHJIG_SHELL_HELPERS — a directory of helper files the adapters delegate
# every check to. The full delegated interface the adapters require of
# that directory:
#   branch_guard.sh        → current_branch, is_protected_branch
#   secret_scan.sh         → scan_staged_secrets (honors a repo-root
#                            .shellsecretignore allow-list)
#   conventional_commit.sh → check_commit_subject (the
#                            `<type>(#<N>)[!]: <subject>` grammar,
#                            subject 1..72 codepoints)
# Anything missing — adapter file, provided function, helper file, or a
# delegated function inside a helper — → no-op (advice tier):
# githook_require guards each delegated function after sourcing, so a
# present-but-incomplete helper degrades to allow, never to a false block.
set -uo pipefail

_gh_top="$(git rev-parse --show-toplevel 2>/dev/null)" || _gh_top=""
_gh_adapter="$_gh_top/.ghjig/shell-adapter.sh"
[ -n "$_gh_top" ] && [ -f "$_gh_adapter" ] || exit 0
# shellcheck source=/dev/null
. "$_gh_adapter" 2>/dev/null || exit 0
command -v safe_source >/dev/null 2>&1 || exit 0
command -v audit_log  >/dev/null 2>&1 || exit 0
[ -n "${GHJIG_SHELL_HELPERS:-}" ] || exit 0

# githook_source <helper-basename> [audit-category] — safe_source a helper
# from the bound shell's helper dir. Returns non-zero (fail-open per
# safe_source) on miss; the adapter then short-circuits to exit 0.
githook_source() {
  safe_source "$GHJIG_SHELL_HELPERS/$1" "${2:-git-hook-tier}"
}

# githook_require <function-name> [audit-category] — advisory-face guard.
# A helper file that sourced cleanly but does not define the delegated
# function would otherwise fail CLOSED at the call site (127 → a false
# block under a wrong cause). If the function is absent, no-op the hook
# from this point — but never silently: the fold leaves one warn record
# naming what was missing (a sourced-clean stub is the one degradation
# shape safe_source cannot see).
githook_require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    ( audit_log warn "${2:-git-hook-tier}" require-missing "$1" ) >/dev/null 2>&1 || true
    exit 0
  fi
}

# githook_block <category> <message> — emit a clear stderr line, best-effort
# audit_log (a subshell so any audit misbehavior cannot abort the hook), and
# return non-zero so git aborts the op on the non-zero hook exit.
githook_block() {
  local category="$1" msg="$2"
  printf '[dev-shell] %s\n' "$msg" >&2
  ( audit_log block "$category" blocked "$msg" ) >/dev/null 2>&1 || true
  return 1
}
