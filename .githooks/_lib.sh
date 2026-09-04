#!/usr/bin/env bash
# .githooks/_lib.sh — shared prelude for the local git-hook enforcement tier.
# Every adapter (pre-commit / pre-push / commit-msg) sources this FIRST. It
# carries the tier's runtime as committed code and exposes:
#   githook_source <helper.sh> [category] — source a helper by basename.
#   githook_require <function> [category] — advisory-face guard.
#   githook_block  <category> <message>   — stderr message + best-effort
#                                            audit_log, returns non-zero.
#   safe_source / audit_log               — the two runtime primitives.
#
# This file DERIVES the two locations the tier needs (§3.2, §4.1, §4.2,
# §4.6) from ONE source the invoking environment cannot move — this file's
# own installed position: the helper directory beside it, and the record
# sink at the top of the repository these adapters are committed in. Both
# sides of the sink therefore perform one derivation rather than agreeing on
# two supplied values (§4.6). The derivation is bounded by a refusal: where
# that repository is not the one this operation runs against, the tier runs
# no check and says so on stderr, because a tier whose checks are committed
# in another repository would write its records there too, across the
# boundary §5.5 draws.
#
# The delegated interface the adapters require of the helper directory:
#   branch_guard.sh        → current_branch, is_protected_branch
#   secret_scan.sh         → scan_staged_secrets (honors a repo-root
#                            .shellsecretignore allow-list)
#   conventional_commit.sh → check_commit_subject (the
#                            `<type>(#<N>)[!]: <subject>` grammar,
#                            subject 1..72 codepoints)
# Anything missing — helper file, or a delegated function inside one — →
# no-op (advice tier): githook_require guards each delegated function after
# sourcing, so a present-but-incomplete helper degrades to allow, never to a
# false block.
#
# Every git child here reads stdin from /dev/null: the pre-push adapter's
# while-read loop over stdin is load-bearing, and a child that gulps stdin
# would silently starve it.
set -uo pipefail

# CDPATH moves the very `cd` the self-location below is built on: git hands
# the adapter a relative argv, so `dirname` yields an operand with no `./`
# prefix and `cd` searches CDPATH's entries before the cwd. Unset here,
# before the first cd, and inherited by every helper this file sources into
# its own shell.
unset CDPATH

# Two tops, both resolved PHYSICALLY (cd + pwd -P) so the comparison below
# reads real paths and never spellings.
#
# `_gh_op_top` is the repository the OPERATION runs against: git's own
# answer from the environment and cwd it handed this hook.
#
# `_gh_top` is the repository these ADAPTERS are committed in, discovered
# from `_gh_here` — the position this file was sourced from. It is the sink's
# source because the operation's top is the caller's to name and the
# adapters' position is not: git runs a hook with cwd at the work tree it was
# told to use, so `GIT_WORK_TREE=<ancestor>` on a `git commit` moves the
# operation's top to a directory the caller chose, and a sink derived from it
# lands outside the repository §5.5 bounds the shell to.
#
# The scrub is three variables measured to move THIS child's answer, each on
# its own: `GIT_DIR` makes it answer the `-C` directory itself, `GIT_WORK_TREE`
# makes it answer the directory the caller named, and `GIT_CEILING_DIRECTORIES`
# makes it fail outright. `GIT_DISCOVERY_ACROSS_FILESYSTEM` joins them as git's
# own documented control on how far discovery walks; it is not measured here,
# since the shape needs a mount boundary. The config-injection family is
# deliberately NOT on the list: with `GIT_DIR` unset, `core.worktree` set from
# the environment was measured not to move this answer, so unsetting it would
# be an unset with no shape behind it. `GIT_DIR` is scrubbed HERE and nowhere
# else — discovery upward from `_gh_here` is what replaces it, and every other
# git child of this hook keeps the one git supplied.
_gh_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || _gh_here=""
if [ -z "$_gh_here" ]; then
  printf '[dev-shell] local hook tier not enforced: the hooks could not resolve their own installed location, so this hook ran no check and wrote no record\n' >&2
  exit 0
fi
_gh_op_top="$(git rev-parse --show-toplevel </dev/null 2>/dev/null)" || _gh_op_top=""
if [ -n "$_gh_op_top" ]; then
  _gh_op_top="$(cd "$_gh_op_top" 2>/dev/null && pwd -P)" || _gh_op_top=""
fi
if [ -z "$_gh_op_top" ]; then
  printf '[dev-shell] local hook tier not enforced: the hooks could not resolve the repository top this operation runs against, so this hook ran no check and wrote no record\n' >&2
  exit 0
fi
_gh_top="$(
  unset GIT_DIR GIT_WORK_TREE GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM
  git -C "$_gh_here" rev-parse --show-toplevel </dev/null 2>/dev/null
)" || _gh_top=""
if [ -n "$_gh_top" ]; then
  _gh_top="$(cd "$_gh_top" 2>/dev/null && pwd -P)" || _gh_top=""
fi
if [ -z "$_gh_top" ] || [ "$_gh_top" != "$_gh_op_top" ]; then
  printf '[dev-shell] local hook tier not enforced: these hooks are not committed in the repository this operation runs against, so this hook ran no check and wrote no record\n' >&2
  exit 0
fi
GHJIG_SHELL_HELPERS="$_gh_here/helpers"
GHJIG_AUDIT_SINK="$_gh_top/.ghjig/state/audit.jsonl"

# audit_log <action> <category> [text...] — append ONE sanitized JSON
# record to the sink: control bytes stripped, backslash and double-quote
# escaped, one printf to an O_APPEND redirect. Composition holds
# unconditionally — one record is one line, and no field's content can
# close its field and open another. Delivery does not: the shell's printf
# writes through a stdio buffer, so a record larger than that buffer
# reaches the sink as several appends, and a second shell writer appending
# concurrently can land between them. Residual (§3.11), measured on darwin
# 25.6.0 / GNU bash 3.2.57 (arm64) at three concurrent writers of 200
# records each: at 200, 700 and 900 bytes of text every one of the 600 lines
# parses; at 1000, 2000 and 8000 some do not. The edge tracks THAT host's
# stdio buffer, so the figures are the host's and the rule above them is
# not. The FIELD boundary holds whatever the interleaving does: the escaping
# above keeps a fragment from opening a field it does not own — 0 crossings
# in the 3474 records that parsed across that sweep. Provenance does not — a
# torn fragment can itself parse, carrying another writer's text under this
# one's category — so a consumer of this trail cannot read parseability as
# provenance. The umask covers the
# 0600 file create only (umask 177, which is the value that yields mode
# 0600); a missing sink directory is created under umask 077 (nested
# subshell) — a dir created without its search bit would silently lose every
# later append and read. Best-effort: it never aborts a hook and always
# returns 0.
#
# The write-through refusal covers every component of the sink path that
# lies inside the shell's own namespace, each derived from the sink path
# rather than spelled by hand: the container (`.ghjig`), the state
# directory (`.ghjig/state`), and the sink file itself. Two questions are
# asked of them, because a link is not the only object that hijacks a
# write. A link at any component is another writer's target — `[ -d ]`,
# `mkdir -p` and the append alike would follow it — so the record is
# dropped. And the sink itself must be a REGULAR file if it exists at all:
# a FIFO is neither a link nor a regular file, and `>>` on a reader-less
# one blocks in open(2), which inside a pre-commit hook is `git commit`
# parked with nothing to reap it. The two directory components need no
# separate type check: `mkdir -p` fails on a non-directory at either of
# them ("File exists" at the state dir, "Not a directory" beneath the
# container) and that failure already drops the record. Components ABOVE
# the namespace (the repository top and its ancestors) are NOT guarded:
# they are not this writer's to own, and a link planted there retargets the
# whole clone, not just this trail.
#
# This function is not the sink's only writer, and the refusals above bind
# THIS one. The extension runtime appends to the same file through
# `appendAuditRecord` (.pi/extensions/ghjig/audit.ts), which opens with
# O_NOFOLLOW|O_NONBLOCK and holds the descriptor to an fstat verdict.
# Neither writer contains the other, and what each covers divides. On the
# LINK dimension this one refuses all three components of the sink path
# named above, while the TS open's O_NOFOLLOW binds the final component
# alone: a link at the container or at the state directory is followed there
# (measured: `appendAuditRecord` writes through a link at either component
# to a destination outside the repository and returns success, where this
# function drops the record). On three dimensions the TS verdict refuses
# what this one does not measure at all — a sink whose inode carries more
# than one name, a sink owned by another account, and any group or other
# mode bit. This writer appends to all three. That is this writer's
# enumerated residual (§3.11), stated here rather than closed: a shell `[ ]`
# probe cannot ask them of the descriptor it is about to write, and asking
# them of the PATH is a different question. The link checks themselves are
# probe-then-append — the shell has no O_NOFOLLOW open, so between `[ -L ]`
# and `>>` a link can be swapped in at a checked component; the TS sibling's
# guarded open closes that window at the one component it guards. The TS
# side states its own ancestor residual in that file's header (§5.5).
audit_log() {
  (
    umask 177
    _ga_action="${1:-warn}"
    _ga_category="${2:-git-hook-tier}"
    if [ "$#" -ge 2 ]; then shift 2; else set --; fi
    case "$_ga_action" in
      *[!A-Za-z0-9_-]*|'') _ga_action=invalid ;;
    esac
    case "$_ga_category" in
      *[!A-Za-z0-9_-]*|'') _ga_category=invalid ;;
    esac
    _ga_text=$(printf '%s' "$*" | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    _ga_ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null) || _ga_ts=unknown
    _ga_dir="${GHJIG_AUDIT_SINK%/*}"
    _ga_ns="${_ga_dir%/*}"
    # Namespace container, state directory, sink file (header note).
    [ -L "$_ga_ns" ] && exit 0
    [ -L "$_ga_dir" ] && exit 0
    [ -d "$_ga_dir" ] || (umask 077; mkdir -p "$_ga_dir") 2>/dev/null || exit 0
    [ -L "$GHJIG_AUDIT_SINK" ] && exit 0
    [ -e "$GHJIG_AUDIT_SINK" ] && [ ! -f "$GHJIG_AUDIT_SINK" ] && exit 0
    printf '{"timestamp":"%s","category":"%s","action":"%s","text":"%s"}\n' \
      "$_ga_ts" "$_ga_category" "$_ga_action" "$_ga_text" >> "$GHJIG_AUDIT_SINK"
  ) 2>/dev/null || true
  return 0
}

# safe_source <file> [category] — source a helper file if present; fail open
# (non-zero) on a miss or on a source that hands back a non-zero status.
# Both shapes leave exactly one record naming the file, in the caller's own
# category: a git operation that folds several hooks over the same degraded
# helper set leaves one record per folded surface (§3.9's per-arm loudness),
# never a shared, collapsed one. A source that does not hand control back at
# all is the githook_source trap's shape, below.
safe_source() {
  local _ss_rc
  if [ -f "$1" ]; then
    # shellcheck source=/dev/null
    . "$1"
    _ss_rc=$?
    [ "$_ss_rc" -eq 0 ] || audit_log warn "${2:-git-hook-tier}" source-incomplete "$(basename -- "$1")"
    return "$_ss_rc"
  fi
  audit_log warn "${2:-git-hook-tier}" helper-missing "$(basename -- "$1")" || true
  return 1
}

# githook_source <helper-basename> [audit-category] — source a helper from
# the derived helper dir. Returns non-zero (fail-open per safe_source) on a
# miss or an incomplete source; the adapter then short-circuits to exit 0.
#
# `exit` inside a SOURCED file terminates this shell, so a trailing
# `|| exit 0` never runs and the hook would carry the sourced file's status
# out to git — a refusal produced by machinery rather than by a check, in
# the one direction this tier promises never to take. An EXIT trap is what
# reaches that shape: `exit` inside the trap sets the shell's status, so a
# source that does not complete folds to allow like every other degradation.
# The line it prints names no CAUSE, because the trap cannot measure one:
# `$?` inside it is 0 both for a sourced `exit 0` and for a signal that
# killed the shell mid-source. It prints at all because this fold turns what
# would otherwise have been a refusal into an allow, and §3.9 forbids a
# disarmed allow that reads like an enforced one — one stderr line plus one
# audit record naming the file.
#
# The window is COUNTED, because a helper may itself call githook_source: an
# inner call that cleared the trap on its way out would leave the outer
# source unguarded, and an `exit` there would carry its status to git — a
# wedged hook with nothing printed.
#
# What the fold COVERS is a committed helper's own error path that ends in
# `exit` or in a non-zero return, with this tier's EXIT slot and the depth
# counter below untouched and the shell still alive. Those are the terms it
# runs on, not exceptions to a wider claim: a sourced file executes in THIS
# shell, so it can reach any of them. Outside those terms the outcome is not
# this tier's to decide, and the fold's line and record may not run.
_GH_SRC_DEPTH=0
githook_source() {
  local _gh_src_rc
  # Read by the trap body when it FIRES rather than when it is armed, so they
  # are set at every entry and `local` puts the outer call's values back when
  # a nested one returns.
  local _gh_src_file="$1" _gh_src_cat="${2:-git-hook-tier}"
  if [ "${_GH_SRC_DEPTH:-0}" -eq 0 ]; then
    trap 'printf "[dev-shell] local hook tier not enforced: a helper did not finish sourcing, so this hook stopped there and ran none of its remaining checks\n" >&2; ( audit_log warn "${_gh_src_cat:-git-hook-tier}" source-incomplete "${_gh_src_file:-unknown}" ) >/dev/null 2>&1 || true; exit 0' EXIT
  fi
  _GH_SRC_DEPTH=$(( ${_GH_SRC_DEPTH:-0} + 1 ))
  safe_source "$GHJIG_SHELL_HELPERS/$_gh_src_file" "$_gh_src_cat"
  _gh_src_rc=$?
  _GH_SRC_DEPTH=$(( ${_GH_SRC_DEPTH:-0} - 1 ))
  [ "${_GH_SRC_DEPTH:-0}" -gt 0 ] || trap - EXIT
  if [ "$_gh_src_rc" -ne 0 ]; then
    printf '[dev-shell] local hook tier not enforced: a helper could not be loaded, so this hook stopped there and ran none of its remaining checks\n' >&2
  fi
  return "$_gh_src_rc"
}

# githook_require <function-name> [audit-category] — advisory-face guard.
# A helper file that sourced cleanly but does not define the delegated
# function would otherwise fail CLOSED at the call site (127 → a false
# block under a wrong cause). If the function is absent, no-op the hook
# from this point — but never silently: the fold leaves one stderr line and
# one warn record naming what was missing (a sourced-clean stub is the one
# degradation shape safe_source cannot see).
githook_require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[dev-shell] local hook tier not enforced: a helper did not define the check this arm delegates to, so this hook stopped there and ran none of its remaining checks\n' >&2
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
