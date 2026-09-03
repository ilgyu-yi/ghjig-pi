#!/usr/bin/env bash
# .githooks/bind_local_tier.sh — the committed arming instrument for the
# local git-hook tier (SPEC §3.2 arming path, §4.1, §4.6, §4.7).
#
# One documented run from anywhere inside a clone of this repository arms
# the committed hook chain for THAT clone. The adapters derive their own
# runtime and their delegated checks from the committed tree, so arming is
# the activation and nothing else:
#
#   1. activates `core.hooksPath` in the clone's OWN (local) config —
#      unset there gets the relative `.githooks` (resolving against each
#      worktree's own top); a value the clone itself carries is compared
#      RESOLVED (cd + pwd -P), so an equivalent spelling is a no-op and
#      only a truly different target is refused (§4.7
#      target's-choice-wins). Scope is load-bearing on both sides: the
#      activation is persistent and per-clone, so an ambient global or
#      system value neither stands in for it nor blocks it, while the final
#      verification also reads the EFFECTIVE value git actually resolves;
#   2. ensures `.ghjig/` is version-control-invisible at creation: no write
#      when `git check-ignore` already answers (the committed anchor), else
#      one line in the RESOLVED `git rev-parse --git-path info/exclude`
#      (never the literal `.git/info/exclude`, which is not a path where
#      `.git` is a gitfile);
#   3. verifies the resolved hooksPath both in the clone's own config (the
#      persistent activation landed) and in the value git resolves (the
#      committed hooks are what will fire). Success (exit 0) is reported
#      only on a verified bound state.
#
# What it refuses (non-zero, the foreign config value left byte-identical):
# a foreign `core.hooksPath` target in the clone's own config, and a value
# at a scope the local activation cannot outrank. Re-running always heals
# states this instrument created; it never overwrites what another writer
# owns. This run writes nothing under `.ghjig/`: per-clone state there is
# data the tier's own record writer creates when it first records (§4.2).
#
# This file is not hook-named, so git never executes it (SPEC §4.1's
# inertness argument); it runs only by explicit operator invocation.
set -uo pipefail

# Constructed-environment hardening for every git child (#39): the
# pathspec-magic family and the repository-retargeting family are unset
# script-wide (a hostile GIT_DIR/GIT_WORK_TREE would rebind ANOTHER
# repository from this cwd; the object/index/namespace members on the
# second line retarget the same clone's storage and ref resolution, so a
# verification would answer about a repository state the consumer is
# not in), replacement objects are refused, and no git child reads this
# terminal's stdin.
#
# GIT_DISCOVERY_ACROSS_FILESYSTEM belongs to the retargeting family and is
# unset with it: it lets `git rev-parse --show-toplevel` walk past a mount
# boundary and answer about an ANCESTOR repository, and every write below
# lands at whatever top that call returns — so the variable names another
# repository's tree as this run's write target.
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_DISCOVERY_ACROSS_FILESYSTEM
unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE GIT_NAMESPACE
# The config-injection family joins the scrub: an inherited GIT_CONFIG
# retargets every `git config` child — the persistent write lands OUTSIDE
# the repository while verification reads the same fabricated answer back
# as "bound: verified" on a clone whose tier is dead.
unset GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT GIT_CEILING_DIRECTORIES
# The write-relocating family: every documented variable that makes a git
# child CREATE OR APPEND a file at a path the ENVIRONMENT names. A
# GIT_TRACE=<path> escapes §4.7's write set, since tracing is on by the mere
# presence of the variable. The roster is enumerated from git's own
# documentation rather than from memory —
#   man git | col -b | grep -o 'GIT_[A-Z0-9_]*' | sort -u
# — and every GIT_TRACE* member it names is unset, the non-path
# modifiers among them included, so a documented member added
# upstream cannot half-arm the scrub. The claim stops there, and stops
# short of "every variable git reads": the TRACE2 modifier family
# (GIT_TRACE2_EVENT_NESTING and its siblings) lives in git's source
# documentation and not in its manual page, so the enumeration above cannot
# reach it and this list does not carry it. Those modifiers change the FORM
# of a trace that one of the DESTINATION variables above must enable first,
# so none of them names a write target on its own. GIT_REDIRECT_* is the
# same destination capability for the child's own streams.
unset GIT_TRACE GIT_TRACE_SETUP GIT_TRACE_PACKET GIT_TRACE_PACKFILE GIT_TRACE_PACK_ACCESS
unset GIT_TRACE_PERFORMANCE GIT_TRACE_SHALLOW GIT_TRACE_CURL GIT_TRACE_CURL_NO_DATA
unset GIT_TRACE_FSMONITOR GIT_TRACE_REFS GIT_TRACE_REDACT
unset GIT_TRACE2 GIT_TRACE2_EVENT GIT_TRACE2_PERF
unset GIT_REDIRECT_STDIN GIT_REDIRECT_STDOUT GIT_REDIRECT_STDERR
# Deliberately NOT scrubbed: HOME and XDG_CONFIG_HOME. The verification must
# mirror the consumer's own config resolution — git resolves core.hooksPath
# through the very global config the operator's git reads, and blinding this
# instrument to it would answer about a repository state no consumer is ever
# in. What that scope may and may not DECIDE is the split stated below.
GIT_NO_REPLACE_OBJECTS=1
export GIT_NO_REPLACE_OBJECTS
unset CDPATH

RE_ARM='bash .githooks/bind_local_tier.sh'

say()  { printf '%s\n' "$1"; }
warn() { printf '%s\n' "$1" >&2; }

# resolve_dir <path> <base> — physical resolution without GNU realpath
# (bash-3.2-safe): a relative <path> resolves against <base>, then
# cd + pwd -P normalizes symlinks. Prints nothing on an unresolvable path.
resolve_dir() {
  _rd_p="$1"
  case "$_rd_p" in
    /*) ;;
    *) _rd_p="$2/$_rd_p" ;;
  esac
  (cd "$_rd_p" 2>/dev/null && pwd -P) 2>/dev/null
}

do_bind() {
  top="$(git rev-parse --show-toplevel </dev/null 2>/dev/null)" || top=""
  if [ -z "$top" ]; then
    warn 'bind_local_tier.sh: not inside a git repository. Run it from a clone of this repository.'
    return 2
  fi
  # Root-only (§4.7): every write below lands at the repository top,
  # wherever the instrument was invoked from.
  cd "$top" || { warn 'bind_local_tier.sh: cannot enter the repository top.'; return 2; }

  # Activation: unset gets the relative spelling (per-worktree resolution);
  # a pre-set value is compared RESOLVED, never byte-wise.
  #
  # SCOPE SPLIT (§4.7): the write decision reads the LOCAL scope only. The
  # activation this instrument makes is persistent and per-clone, so an
  # ambient global or system value must not stand in for it — it travels
  # with the environment, not with the clone, and taking it as "already
  # bound" would report a verified state that evaporates in any other
  # environment while nothing was written here. For the same reason a
  # foreign value refuses only when THIS clone carries it AT THIS SCOPE: a
  # global- or system-origin foreign hooks path is not this clone's choice,
  # and the local activation written below outranks both in git's own
  # precedence, so the re-arm command discharges in one run instead of
  # sending the operator hunting for a config origin. What local does NOT
  # outrank is the worktree scope; that is why the write decision here is
  # not also the verdict, and the verification below reads the merged value
  # before any success is reported.
  _bd_want="$(resolve_dir "$top/.githooks" "$top")"
  if [ -z "$_bd_want" ]; then
    warn 'bind_local_tier.sh: the committed .githooks directory is missing at the repository top - nothing to bind core.hooksPath to.'
    return 2
  fi
  _bd_hp="$(git config --local --get core.hooksPath </dev/null 2>/dev/null)" || _bd_hp=""
  if [ -z "$_bd_hp" ]; then
    git config --local core.hooksPath .githooks </dev/null || { warn 'bind_local_tier.sh: could not set core.hooksPath.'; return 2; }
    say "core.hooksPath: set to .githooks in this clone's own config (relative - resolves against each worktree top)."
  else
    _bd_have="$(resolve_dir "$_bd_hp" "$top")"
    if [ -n "$_bd_have" ] && [ "$_bd_have" = "$_bd_want" ]; then
      say "core.hooksPath: this clone's own config already resolves to the committed .githooks directory - equivalent spelling, left unchanged (no-op)."
    else
      # What this arm MEASURED is the local scope alone, so that is all it
      # says. It does not conclude that the committed hooks will not fire:
      # local is not the top of git's precedence, and a worktree-scope value
      # naming the committed .githooks makes the clone effectively bound while
      # this read still refuses. Verification does not inherit the write's
      # scope binding (§4.7) - and neither does a refusal.
      warn "bind_local_tier.sh: core.hooksPath is set in this clone's own config to a different hook directory - that target's choice wins, so it is left unchanged and this run wrote no activation. What git actually resolves is a separate question this refusal does not answer; 'git config --get core.hooksPath' reads the merged value. To bind this clone at its own scope, unset it (git config --local --unset core.hooksPath), then re-run: $RE_ARM"
      return 5
    fi
  fi

  # Exclusion at creation (§4.1, §5.5): the committed anchor answers on
  # every normal clone; the fallback writes the RESOLVED info/exclude.
  if git check-ignore -q -- .ghjig/state/audit.jsonl </dev/null 2>/dev/null; then
    say 'exclusion: .ghjig/ is already version-control-invisible - no write.'
  else
    _bd_excl="$(git rev-parse --git-path info/exclude </dev/null 2>/dev/null)" || _bd_excl=""
    if [ -z "$_bd_excl" ]; then
      warn 'bind_local_tier.sh: could not resolve the info/exclude path.'
      return 2
    fi
    case "$_bd_excl" in
      /*) ;;
      *) _bd_excl="$top/$_bd_excl" ;;
    esac
    _bd_excl_dir="${_bd_excl%/*}"
    [ -d "$_bd_excl_dir" ] || (umask 077; mkdir -p "$_bd_excl_dir") || { warn 'bind_local_tier.sh: cannot create the info/exclude directory.'; return 2; }
    printf '%s\n' '/.ghjig/' >> "$_bd_excl" || { warn 'bind_local_tier.sh: could not append the exclusion line.'; return 2; }
    say 'exclusion: appended /.ghjig/ to the resolved info/exclude.'
  fi

  # Verification has two halves, because the success line below claims two
  # different things.
  #
  # 1. The LOCAL scope must carry the activation: it is the persistent,
  #    per-clone state this run exists to leave, and a merged read alone
  #    would let an ambient value certify a write that never happened.
  _bd_final_hp="$(git config --local --get core.hooksPath </dev/null 2>/dev/null)" || _bd_final_hp=""
  _bd_final="$(resolve_dir "$_bd_final_hp" "$top")"
  if [ -z "$_bd_final" ] || [ "$_bd_final" != "$_bd_want" ]; then
    warn "bind_local_tier.sh: verification failed - this clone's own core.hooksPath does not resolve to the committed .githooks directory. This clone is NOT verified bound."
    return 6
  fi
  # 2. The EFFECTIVE value must be that same directory: "the committed hooks
  #    will fire" is a claim about what git resolves, and only the merged
  #    read answers it. Local outranks global and system, so those cannot
  #    reach this arm - but local is NOT the top of the precedence: with
  #    extensions.worktreeConfig enabled a WORKTREE-scope value outranks it,
  #    and a local-only verification would report a verified bound state on a
  #    clone whose commits fire a foreign hook directory. The refusal names
  #    the scope carrying the overriding value, because an operator cannot
  #    clear a scope the message never names - and where this git cannot
  #    name one, the message says so and prescribes the lookup instead of a
  #    scope it guessed (a named act that does not exist is worse than
  #    none).
  _bd_eff_hp="$(git config --get core.hooksPath </dev/null 2>/dev/null)" || _bd_eff_hp=""
  _bd_eff="$(resolve_dir "$_bd_eff_hp" "$top")"
  if [ -z "$_bd_eff" ] || [ "$_bd_eff" != "$_bd_want" ]; then
    _bd_eff_scope="$(git config --show-scope --get core.hooksPath </dev/null 2>/dev/null | head -n 1 | cut -f 1)" || _bd_eff_scope=""
    case "$_bd_eff_scope" in
      local|global|system|worktree)
        _bd_eff_where="from the $_bd_eff_scope scope"
        _bd_eff_fix="clear it (git config --$_bd_eff_scope --unset core.hooksPath)"
        ;;
      *)
        _bd_eff_where="from a scope this git does not report"
        _bd_eff_fix="find the file carrying it (git config --show-origin --get core.hooksPath) and clear it there"
        ;;
    esac
    # "is in place", not "was written": this arm is reached both from the
    # branch that wrote the local value and from the branch where the clone
    # already carried an equivalent one and nothing was written. The first
    # verification half above established that the value resolves; which run
    # put it there is not something this arm measured.
    warn "bind_local_tier.sh: verification failed - the per-clone activation is in place in this clone's own config, but git resolves core.hooksPath to '$_bd_eff_hp' $_bd_eff_where, which outranks the local scope. The committed hooks would NOT fire, so this clone is NOT verified bound. To bind this clone, $_bd_eff_fix, then re-run: $RE_ARM"
    return 6
  fi
  say 'bound: verified - the local git-hook tier is armed for this worktree (core.hooksPath + exclusion).'
  return 0
}

case "${1:-}" in
  '')
    do_bind
    exit $?
    ;;
  *)
    warn "bind_local_tier.sh: unknown argument (usage: $RE_ARM)."
    exit 2
    ;;
esac
