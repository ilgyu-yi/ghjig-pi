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
# knowledge of that shell's layout and runtime interface lives in the
# adapter, never in this committed file. On sourcing, the adapter must
# provide: `safe_source`, `audit_log` (functions) and GHJIG_SHELL_HELPERS
# (the shell's helper dir). Anything missing → no-op (advice tier).
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

# githook_block <category> <message> — emit a clear stderr line, best-effort
# audit_log (a subshell so any audit misbehavior cannot abort the hook), and
# return non-zero so git aborts the op on the non-zero hook exit.
githook_block() {
  local category="$1" msg="$2"
  printf '[dev-shell] %s\n' "$msg" >&2
  ( audit_log block "$category" blocked "$msg" ) >/dev/null 2>&1 || true
  return 1
}
