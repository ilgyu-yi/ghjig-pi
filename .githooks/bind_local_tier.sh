#!/usr/bin/env bash
# .githooks/bind_local_tier.sh — the committed arming instrument for the
# local git-hook tier (SPEC §3.2 arming path, §4.1, §4.6, §4.7).
#
# One documented run from the repository root of a clone of this repository
# arms the committed hook chain for THAT clone. The adapters derive their own
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
#      `.git` is a gitfile) — after which git is RE-ASKED whether the path
#      is ignored, since a rule outside that file can outrank it and leave
#      the append inert;
#   3. verifies the resolved hooksPath both in the clone's own config (the
#      persistent activation landed) and in the value git resolves (the
#      committed hooks are what will fire). Success (exit 0) is reported
#      only on a verified bound state.
#
# What it refuses (non-zero, the foreign config value left byte-identical):
# a `core.hooksPath` in the clone's own config that does not resolve to the
# committed adapters, a value at a scope the local activation cannot
# outrank, a local value this git cannot read at all, and an exclusion that
# git still does not honor after the append. Re-running always heals
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
#
# The consequence of the scrub, which the roster above is the whole census
# of: a variable on it that the invoking shell carries is live for that
# shell's own git and absent for every child here, so this run's verdict and
# `git config --get core.hooksPath` typed in that same shell can differ.
# The verdict is the one about the clone — the activation this run leaves is
# persistent and per-clone, while the shell's answer travels with the
# environment (measured: with GIT_CONFIG_COUNT=1, GIT_CONFIG_KEY_0=
# core.hooksPath and GIT_CONFIG_VALUE_0 naming a foreign directory, this run
# reports `bound: verified` in a shell whose own git reports that foreign
# directory).
GIT_NO_REPLACE_OBJECTS=1
export GIT_NO_REPLACE_OBJECTS
unset CDPATH

RE_ARM='bash .githooks/bind_local_tier.sh'

say()  { printf '%s\n' "$1"; }
warn() { printf '%s\n' "$1" >&2; }

# resolve_dir <path> <base> — physical resolution without GNU realpath
# (bash-3.2-safe): a relative <path> resolves against <base>, then
# cd + pwd -P normalizes symlinks. Prints nothing on a path this account
# cannot enter. An EMPTY <path> is not that shape: it resolves to <base>,
# which each caller below then compares against the committed directory like
# any other resolved path.
resolve_dir() {
  _rd_p="$1"
  case "$_rd_p" in
    /*) ;;
    *) _rd_p="$2/$_rd_p" ;;
  esac
  (cd "$_rd_p" 2>/dev/null && pwd -P) 2>/dev/null
}

_BD_LF='
'

# read_config <git-config-args…> — one `git config` read whose VALUE and EXIT
# STATUS both survive the capture, into `_cfg_value` and `_cfg_rc`.
#
# Command substitution strips EVERY trailing newline, and git stores and
# resolves a `core.hooksPath` that ends in one: the value `.githooks<LF>` names
# a directory that does not exist, git fires no hook under it, and a stripped
# capture compares `.githooks` — a path git never resolved — and finds it
# equivalent. The sentinel appended INSIDE the substitution is what the strip
# lands on instead; git terminates its own output with exactly one newline,
# which is removed once, and no other byte is touched. The status rides the
# same capture because `$?` after a substitution is the substitution's last
# command rather than git's.
read_config() {
  _cfg_raw="$(git config "$@" </dev/null 2>/dev/null; printf 'X%s' "$?")"
  _cfg_rc="${_cfg_raw##*X}"
  _cfg_value="${_cfg_raw%X*}"
  _cfg_value="${_cfg_value%"$_BD_LF"}"
}

# clear_act <scope-flag> <scope-name> — the act that REMOVES core.hooksPath at
# one scope, composed from what this clone measures there rather than from a
# fixed spelling, into `_ca_act`. Two documented behaviours decide it, and a
# message built without either prescribes an act that exits non-zero on the
# very shape that reached it:
#
#   `git help config` EXIT STATUS — "you try to unset/set an option for which
#   multiple lines match (ret=5)", while `get` "emits the last value", so a
#   multi-valued key reaches a refusal with rc 0 and `--unset` is dead there;
#   `--unset-all` is the live act, and only where the read counted more than
#   one, since clearing N values a refusal named one of is the same
#   target's-choice violation in the other direction (§4.7).
#
#   `git help config` --includes — "Defaults to off when a specific file is
#   given (e.g., using --file, --global, etc)", so a scope can RESOLVE a value
#   that lives in an included file, which no `git config --<scope> --unset`
#   reaches. Where the two counts differ, the file is git's to name and this
#   run prescribes the lookup rather than a scope it guessed.
#
# Counting is NUL-terminated (`-z`: "always end values with the null
# character"), because a config value may itself contain a newline.
clear_act() {
  _ca_own="$(git config -z "$1" --no-includes --get-all core.hooksPath </dev/null 2>/dev/null | LC_ALL=C tr -dc '\000' | LC_ALL=C wc -c)"
  _ca_all="$(git config -z "$1" --includes --get-all core.hooksPath </dev/null 2>/dev/null | LC_ALL=C tr -dc '\000' | LC_ALL=C wc -c)"
  _ca_own=$((_ca_own))
  _ca_all=$((_ca_all))
  if [ "$_ca_own" -eq 1 ] && [ "$_ca_all" -eq 1 ]; then
    _ca_act="clear it (git config --$2 --unset core.hooksPath)"
  elif [ "$_ca_own" -ge 1 ] && [ "$_ca_own" -eq "$_ca_all" ]; then
    _ca_act="clear all $_ca_own values this scope carries (git config --$2 --unset-all core.hooksPath)"
  else
    _ca_act="find the file carrying it (git config --show-origin --get-all core.hooksPath) and remove the line there"
  fi
}

do_bind() {
  top="$(git rev-parse --show-toplevel </dev/null 2>/dev/null)" || top=""
  if [ -z "$top" ]; then
    warn 'bind_local_tier.sh: no repository top resolved here - git rev-parse --show-toplevel gave no answer. Run it from inside a clone of this repository.'
    return 2
  fi
  # Root-only (§4.7): every write below lands at the repository top,
  # wherever the instrument was invoked from. The top is re-read PHYSICALLY
  # after the cd, so the containment test below compares two physically
  # resolved paths and never one of each.
  cd "$top" || { warn 'bind_local_tier.sh: cannot enter the repository top.'; return 2; }
  top="$(pwd -P)" || { warn 'bind_local_tier.sh: cannot resolve the repository top.'; return 2; }

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
    warn 'bind_local_tier.sh: the .githooks directory at the repository top cannot be entered - it is absent, is not a directory, or this account cannot search it - so there is nothing to bind core.hooksPath to.'
    return 2
  fi
  # The success line below says the tier is ARMED, so what it verifies is
  # what the adapters need to run: the directory it binds to must lie under
  # this repository (a `.githooks` link escaping the top resolves to a tree
  # the tier's own prelude refuses at commit time — see `_lib.sh`'s
  # derivation), and each of the three adapters git will execute must be a
  # regular file, non-empty, and executable by this account. The containment
  # test below uses the same quoted-pattern form as the prelude, so a
  # repository path carrying glob bytes is matched literally, and compares the
  # same physically resolved pair — but the predicate is containment HERE and
  # an equality THERE, because the two ask different questions: this one asks
  # where the bound directory sits, the prelude asks whether the running
  # adapter's own repository is the one the operation runs against. What the
  # adapter test asks is ARMING, not provenance: git runs a hook file that is
  # present and executable and skips one that is not, and an empty file runs
  # as a no-op — so those three questions are the ones a claim about firing
  # rests on. An executable, non-empty adapter whose body decides nothing
  # still passes here, and whether these bytes are the repository's committed
  # ones is not asked.
  case "$_bd_want/" in
    "$top"/*) ;;
    *)
      warn "bind_local_tier.sh: the .githooks directory at the repository top resolves outside this repository, so this run will not bind core.hooksPath there. This clone is NOT verified bound."
      return 2
      ;;
  esac
  # Each of the three questions gets its own message, because the act that
  # repairs one is dead for another: `git checkout -- .githooks` restores an
  # absent or emptied adapter (measured, both), while under
  # `core.fileMode=false` a lost exec bit is not a difference git records, so
  # the same checkout returns 0, changes nothing, and the re-arm refuses again
  # — an operator following it loops. `chmod +x` is the live act there, and it
  # is live under `core.fileMode=true` as well.
  for _bd_adapter in pre-commit pre-push commit-msg; do
    if [ ! -f "$_bd_want/$_bd_adapter" ] || [ ! -s "$_bd_want/$_bd_adapter" ]; then
      warn "bind_local_tier.sh: the adapter '$_bd_adapter' in the .githooks directory is absent or empty, so binding core.hooksPath there would arm nothing. This clone is NOT verified bound. Restore the committed adapters (git checkout -- .githooks), then re-run from the repository root: $RE_ARM"
      return 2
    fi
    if [ ! -x "$_bd_want/$_bd_adapter" ]; then
      warn "bind_local_tier.sh: the adapter '$_bd_adapter' in the .githooks directory is not executable by this account, so git would skip it and binding core.hooksPath there would arm nothing. This clone is NOT verified bound. Restore the mode (chmod +x .githooks/pre-commit .githooks/pre-push .githooks/commit-msg), then re-run from the repository root: $RE_ARM"
      return 2
    fi
  done
  # Two properties of this ONE read, both load-bearing.
  #
  # The EXIT STATUS is preserved, because it is the only thing that separates
  # a key this clone does not carry (rc 1) from one it carries as the empty
  # string (rc 0): git hands back the same empty value for both, so a
  # discarded status makes the run overwrite a "no hooks" setting the
  # operator chose - a value this clone carries, which §4.7 leaves to its
  # target. Only rc 1 activates; rc 0 falls through to the compare below,
  # where an empty value cannot equal the committed directory and takes the
  # skip-with-warning path that already exists. Any other status also lands
  # there: this read did not establish an absent key, and refusing without
  # writing is the recoverable direction.
  #
  # `--path` makes the compare read what GIT reads: it expands a `~/`-spelled
  # value to the absolute path git itself resolves core.hooksPath to, and
  # leaves a relative spelling untouched, so an equivalent spelling of the
  # committed adapters is the no-op §4.7 names rather than a foreign
  # collision. It is used for RESOLUTION only - the operator-facing message
  # below shows the raw spelling they typed. The read goes through
  # `read_config` so the value it compares is the byte string git resolves,
  # trailing newline included (that function's note).
  #
  # `--includes` is what makes this read the LOCAL SCOPE's own answer rather
  # than one file's: git turns include expansion off when a scope is named
  # (`clear_act`'s note), while `--show-scope` still reports an
  # include-carried value as `local`. Without it this read answers "no value"
  # on a clone whose local scope resolves one, and the write below would
  # outrank a target's choice with no warning on any surface.
  read_config --local --includes --path --get core.hooksPath
  _bd_hp="$_cfg_value"
  _bd_hp_rc="$_cfg_rc"
  if [ "$_bd_hp_rc" -eq 1 ]; then
    git config --local core.hooksPath .githooks </dev/null || { warn 'bind_local_tier.sh: could not set core.hooksPath.'; return 2; }
    say "core.hooksPath: set to .githooks in this clone's own config (relative - resolves against each worktree top)."
  elif [ "$_bd_hp_rc" -ne 0 ]; then
    # The arm the two branches around it do not cover, and it says only what
    # it measured: this read established neither an absent key (rc 1) nor a
    # value (rc 0), so the message names no directory and prescribes no
    # `git config` act. On the shapes measured here - a `~user` git cannot
    # expand, and a `hooksPath` key carrying no value - every `git config`
    # read of this scope and `--unset` itself exit 128 too, so a prescribed
    # `git config` act would be a dead one. `git rev-parse` still answers,
    # and the LOCAL scope's file is the common dir's `config` in a linked
    # worktree as much as in an ordinary clone (measured).
    _bd_cfg_dir="$(git rev-parse --git-common-dir </dev/null 2>/dev/null)" || _bd_cfg_dir=""
    case "$_bd_cfg_dir" in
      ''|/*) ;;
      *) _bd_cfg_dir="$top/$_bd_cfg_dir" ;;
    esac
    if [ -n "$_bd_cfg_dir" ]; then
      _bd_cfg_shown="$(printf '%s' "$_bd_cfg_dir/config" | LC_ALL=C tr -d '\000-\037\177')"
      _bd_cfg_where="the core.hooksPath line in '$_bd_cfg_shown'"
    else
      _bd_cfg_where="the core.hooksPath line in this clone's own config file"
    fi
    warn "bind_local_tier.sh: reading core.hooksPath from this clone's own config exited $_bd_hp_rc, so this run did not establish what this clone carries and wrote no activation. This clone is NOT verified bound. Repair or remove $_bd_cfg_where by hand, then re-run from the repository root: $RE_ARM"
    return 5
  else
    _bd_have="$(resolve_dir "$_bd_hp" "$top")"
    if [ -n "$_bd_have" ] && [ "$_bd_have" = "$_bd_want" ]; then
      say "core.hooksPath: this clone's own config already resolves to the committed .githooks directory - equivalent spelling, left unchanged (no-op)."
    else
      # What this arm MEASURED is the local scope alone, so that is all it
      # says. It names no target directory either: rc 0 means this clone
      # carries a value, which the empty string also is, and git fires no
      # hook under that one. It does not conclude that the committed hooks
      # will not fire: local is not the top of git's precedence, and a
      # worktree-scope value naming the committed .githooks makes the clone
      # effectively bound while this read still refuses. Verification does not
      # inherit the write's scope binding (§4.7) - and neither does a refusal.
      clear_act --local local
      warn "bind_local_tier.sh: this clone's own config carries a core.hooksPath that does not resolve to the committed .githooks directory - that target's choice wins, so it is left unchanged and this run wrote no activation. What git actually resolves is a separate question this refusal does not answer; 'git config --get core.hooksPath' reads the merged value. To bind this clone at its own scope, $_ca_act, then re-run from the repository root: $RE_ARM"
      return 5
    fi
  fi

  # Exclusion at creation (§4.1, §5.5): the committed anchor answers on
  # every normal clone; the fallback writes the RESOLVED info/exclude.
  _bd_verified=' (core.hooksPath + exclusion)'
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
    # This append is the same hazard the record writer in `_lib.sh` guards,
    # so it asks the same questions in the same order, derived from the
    # resolved path rather than spelled by hand: a link at the directory
    # component this run may CREATE, a link at the leaf, and a leaf that
    # exists as something other than a regular file. `mkdir -p` and `>>`
    # alike follow a link, so either one would land the exclusion in a file
    # the operator never named while this run reported success. Components
    # ABOVE the one created here are not guarded: they are not this writer's
    # to own, and a link planted there retargets the whole clone. An ABSENT
    # exclude file is not a refusal - creating and appending it is the
    # fallback's whole job.
    #
    # The reach of the three questions is where control arrives at them:
    # `git check-ignore` above has already run a git child against this
    # clone's exclude file, so a leaf shape that parks git itself never gets
    # here. Measured on a FIFO at that path: plain `git status --porcelain`
    # parks with no hook and no instrument involved, and the run is killed
    # inside that child. Asking these questions earlier would make them a
    # precondition on every run, including the ordinary one where the
    # committed anchor answers and this instrument writes nothing at all.
    #
    # Each question gets its own message: the object at fault differs, and a
    # refusal that names the leaf when the offender is one component above it
    # sends the operator to replace a file that is already fine.
    _bd_excl_dir="${_bd_excl%/*}"
    # Same rendering rule as the effective-value refusal below: the paths are
    # git's to supply and these lines are a terminal's, so control bytes come
    # out at the interpolation.
    _bd_excl_shown="$(printf '%s' "$_bd_excl" | LC_ALL=C tr -d '\000-\037\177')"
    _bd_excl_dir_shown="$(printf '%s' "$_bd_excl_dir" | LC_ALL=C tr -d '\000-\037\177')"
    if [ -L "$_bd_excl_dir" ]; then
      warn "bind_local_tier.sh: the directory holding the resolved info/exclude, '$_bd_excl_dir_shown', is a symbolic link, so the exclusion was NOT written and this clone is NOT verified bound - mkdir -p and the append alike follow it, and both would land wherever it points. Replace it with a real directory (or none), then re-run from the repository root: $RE_ARM"
      return 2
    fi
    if [ -L "$_bd_excl" ]; then
      warn "bind_local_tier.sh: the resolved info/exclude path '$_bd_excl_shown' is a symbolic link, so the exclusion was NOT written and this clone is NOT verified bound - an append there would land wherever that link points. Replace it with a regular file (or none), then re-run from the repository root: $RE_ARM"
      return 2
    fi
    if [ -e "$_bd_excl" ] && [ ! -f "$_bd_excl" ]; then
      warn "bind_local_tier.sh: the resolved info/exclude path '$_bd_excl_shown' exists and is not a regular file, so the exclusion was NOT written and this clone is NOT verified bound - an append there is not the file write this run means to make. Replace it with a regular file (or none), then re-run from the repository root: $RE_ARM"
      return 2
    fi
    [ -d "$_bd_excl_dir" ] || (umask 077; mkdir -p "$_bd_excl_dir") || { warn 'bind_local_tier.sh: cannot create the info/exclude directory.'; return 2; }
    # This file is LINE-ORIENTED, not a byte sink: `git help gitignore` -
    # "Each line in a gitignore file specifies a pattern" - and git honours a
    # final line that carries no terminator (measured: check-ignore answers 0
    # on a 12-byte exclude ending without one). Both halves of the write
    # follow from that one sentence and neither is optional:
    #
    #   MEMBERSHIP IS A LINE, so the test is `grep -x` and a re-run adds
    #   nothing. The refusal below prescribes a re-run on the shape where a
    #   rule outside this file outranks the append, so an append that only
    #   asked "did the write succeed" grows the file once per instruction.
    #
    #   THE OPERATOR'S LAST LINE IS THEIRS, so an unterminated one is
    #   terminated BEFORE the append. Concatenating onto it silently rewrites
    #   a rule this run does not own into a different pattern (§4.7) - and the
    #   re-ask below cannot see it, because the appended pattern still works
    #   while the damage is to a path nothing here asks about.
    #
    # The last byte is read through `od` rather than a command substitution,
    # which strips exactly the byte under test.
    if LC_ALL=C grep -qxF '/.ghjig/' "$_bd_excl" 2>/dev/null; then
      say 'exclusion: /.ghjig/ is already a line in the resolved info/exclude - no write.'
    else
      _bd_excl_last="$(tail -c 1 "$_bd_excl" 2>/dev/null | LC_ALL=C od -An -tu1 | LC_ALL=C tr -dc '0-9')"
      if [ -n "$_bd_excl_last" ] && [ "$_bd_excl_last" != "10" ]; then
        printf '\n' >> "$_bd_excl" || { warn 'bind_local_tier.sh: could not terminate the last line of the resolved info/exclude.'; return 2; }
      fi
      printf '%s\n' '/.ghjig/' >> "$_bd_excl" || { warn 'bind_local_tier.sh: could not append the exclusion line.'; return 2; }
      say 'exclusion: appended /.ghjig/ to the resolved info/exclude.'
    fi
    # The success line below names the exclusion as one of two verified
    # properties, so the append is MEASURED rather than assumed: git's own
    # precedence lets a rule outside this file decide the path - a `.gitignore`
    # in the work tree outranks info/exclude - and then the line just written
    # changes nothing while the run reports an invisible state root.
    #
    # Only a DEFINITE "not ignored" refuses. `check-ignore` answers 0, 1 or
    # 128; the last means it could not answer, and refusing on an unanswered
    # question would turn this fix into a block on a clone this run has no
    # evidence against.
    git check-ignore -q -- .ghjig/state/audit.jsonl </dev/null 2>/dev/null
    _bd_ci_rc=$?
    if [ "$_bd_ci_rc" -eq 1 ]; then
      warn "bind_local_tier.sh: the exclusion line is present in '$_bd_excl_shown', but git still reports .ghjig/ as not ignored, so the shell's own state would be visible to version control here. This clone is NOT verified bound. Re-run from the repository root once git ignores that path: $RE_ARM"
      return 2
    fi
    # The success line names the exclusion only where this re-ask ANSWERED.
    # `git help check-ignore` documents a third exit status, 128.
    if [ "$_bd_ci_rc" -ne 0 ]; then
      _bd_verified=' (core.hooksPath)'
    fi
  fi

  # Verification has two halves, because the success line below claims two
  # different things.
  #
  # 1. The LOCAL scope must carry the activation: it is the persistent,
  #    per-clone state this run exists to leave, and a merged read alone
  #    would let an ambient value certify a write that never happened.
  #    Resolution reads the expanded value here too (the read above's note):
  #    a spelling git expands must be compared as git expands it, or this
  #    half refuses the very activation the branch above declared equivalent.
  #    `--includes` for the same reason it is on the read above, and at the
  #    same time: measured, moving it at one of the two sites alone refuses a
  #    clone that IS bound through an include and whose chain fires.
  read_config --local --includes --path --get core.hooksPath
  _bd_final="$(resolve_dir "$_cfg_value" "$top")"
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
  #    The compare reads the expanded value and the message below reads the
  #    raw one: what the operator has to clear is the spelling they typed.
  read_config --path --get core.hooksPath
  _bd_eff="$(resolve_dir "$_cfg_value" "$top")"
  read_config --get core.hooksPath
  _bd_eff_hp="$_cfg_value"
  if [ -z "$_bd_eff" ] || [ "$_bd_eff" != "$_bd_want" ]; then
    _bd_eff_scope="$(git config --show-scope --get core.hooksPath </dev/null 2>/dev/null | head -n 1 | cut -f 1)" || _bd_eff_scope=""
    case "$_bd_eff_scope" in
      local|global|system|worktree)
        _bd_eff_where="from the $_bd_eff_scope scope"
        # The act is composed for the shape THAT scope actually carries, not
        # for the scope's name: the same `--unset` this line used to spell is
        # dead on a multi-valued key and on a value the scope resolves through
        # an include (`clear_act`'s note), and both reach this arm.
        clear_act "--$_bd_eff_scope" "$_bd_eff_scope"
        _bd_eff_fix="$_ca_act"
        ;;
      *)
        _bd_eff_where="from a scope this git does not report"
        # `--get-all`, not `--get`: `git help config` on get - "If key is
        # present multiple times in the configuration, emits the last value" -
        # so `--get` names one file where several may carry the value.
        _bd_eff_fix="find the file carrying it (git config --show-origin --get-all core.hooksPath) and clear it there"
        ;;
    esac
    # The foreign value is git's to supply and this line is a terminal's to
    # render, so the control bytes come out at the interpolation — the same
    # `tr` the record writer in `_lib.sh` applies to every text it composes.
    _bd_eff_shown="$(printf '%s' "$_bd_eff_hp" | LC_ALL=C tr -d '\000-\037\177')"
    # "is in place", not "was written": this arm is reached both from the
    # branch that wrote the local value and from the branch where the clone
    # already carried an equivalent one and nothing was written. The first
    # verification half above established that the value resolves; which run
    # put it there is not something this arm measured.
    warn "bind_local_tier.sh: verification failed - the per-clone activation is in place in this clone's own config, but git resolves core.hooksPath to '$_bd_eff_shown' $_bd_eff_where, which outranks the local scope. The committed hooks would NOT fire, so this clone is NOT verified bound. To bind this clone, $_bd_eff_fix, then re-run from the repository root: $RE_ARM"
    return 6
  fi
  say "bound: verified - the local git-hook tier is armed for this worktree$_bd_verified."
  return 0
}

case "${1:-}" in
  '')
    do_bind
    exit $?
    ;;
  *)
    warn "bind_local_tier.sh: unknown argument (usage: $RE_ARM, run from the repository root)."
    exit 2
    ;;
esac
