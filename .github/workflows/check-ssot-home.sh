#!/usr/bin/env bash
# check-ssot-home.sh — SSOT-home discipline gate.
#
# Usage:
#   check-ssot-home.sh                 # operate on the current dir (root = .)
#   check-ssot-home.sh --root <dir>    # operate on <dir> instead
#
# Enforces the docs-thin-pointer discipline (Rule 1) and adds a Rule-2
# SSOT-presence arm plus a track-active guard. When a
# repo's docs/ already point at a SPEC ("SPEC §…"), the external contract must
# actually live in SPEC.md — not be scattered across docs/.
#
# Paired remediation: every failure carries a concrete next step on
# stderr (create SPEC.md / home the prose in SPEC.md) — no bare "wrong" gate.
#
# Rule 1 reads only the lead window (first two non-empty lines) and applies a
# lenient *SPEC* substring test.
#
# Self-contained stub detection: no scaffold template file is assumed to
# exist alongside this script, so the stub
# signature is detected structurally from SPEC.md's own body (all body lines are
# <…> angle-bracket placeholders) — never by comparison to a template file. The
# detection is false-skip-biased: any real prose line ⇒ NOT a stub (the safe
# direction), so a mid-onboarding SPEC with genuine prose is never mis-failed.
#
# Pure bash. No third-party Actions; runs under check-ssot-home.yml.

set -uo pipefail

ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --root)   shift; ROOT="${1:?check-ssot-home: --root requires a dir}" ;;
    --root=*) ROOT="${1#--root=}" ;;
    *) echo "check-ssot-home: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SPEC="$ROOT/SPEC.md"

# lead-window(file) — first two non-empty lines. awk (not a `head` pipe)
# avoids SIGPIPE/pipefail/BSD-vs-GNU nondeterminism.
lead_window() {  # $1 = file
  awk 'NF{n++; print; if(n==2) exit}' "$1"
}

# spec_is_stub(file) — true (exit 0) iff SPEC.md is a scaffold stub: after
# dropping the ToC block, the set of body-content lines (non-blank lines that
# are not headings `^#`, blockquote guidance `^>`, or the ToC) is non-empty AND
# every one of them is a `<…>` angle-bracket placeholder. `## Last reviewed:` is
# a heading, so it is already excluded. Any real prose line ⇒ NOT a stub.
spec_is_stub() {  # $1 = spec file
  awk '
    index($0, "<!-- TOC START") { in_toc = 1; next }
    index($0, "<!-- TOC END")   { in_toc = 0; next }
    in_toc                      { next }
    /^[[:space:]]*$/            { next }
    /^#/                        { next }
    /^>/                        { next }
    {
      body++
      if ($0 !~ /^[[:space:]]*<.*>[[:space:]]*$/) real++
    }
    END { if (body > 0 && real == 0) exit 0; else exit 1 }
  ' "$1"
}

spec_present=0
[ -f "$SPEC" ] && spec_present=1

# docs_leads_spec_anchored — some docs/*.md leads (first two non-empty lines)
# with the ANCHORED token "SPEC §" (strict; the Rule-2/track-active trigger).
# false-skip-biased: an incidental mid-body "SPEC §" cannot flip a contract-less
# repo active. nullglob guards a missing docs/ dir (loop simply does not run).
shopt -s nullglob
docs_anchored=0
for f in "$ROOT"/docs/*.md; do
  lead=$(lead_window "$f")
  if [[ "$lead" == *"SPEC §"* ]]; then
    docs_anchored=1
  fi
done

# track-active guard (invariant 1): a genuinely contract-less repo (no SPEC.md
# AND no docs lead pointing at one) is left untouched — skip clean.
if [ "$spec_present" = 0 ] && [ "$docs_anchored" = 0 ]; then
  exit 0
fi

# Track-active: evaluate BOTH rules and accumulate ALL failures (no
# first-failure short-circuit). All ::error:: → stderr.
fail=0

# Rule 2 (SSOT-presence): docs point at a SPEC but the content home is absent
# or still a scaffold stub.
if [ "$docs_anchored" = 1 ]; then
  if [ "$spec_present" = 0 ] || spec_is_stub "$SPEC"; then
    echo "::error::docs/ lead with a 'SPEC §' pointer but SPEC.md is absent or a stub. To fix, create SPEC.md as the content home your docs already reference." >&2
    fail=1
  fi
fi

# Rule 1 (docs-thin-pointer): every docs/*.md must lead with a SPEC
# reference (lenient *SPEC* substring).
for f in "$ROOT"/docs/*.md; do
  lead=$(lead_window "$f")
  if [[ "$lead" != *SPEC* ]]; then
    name=$(basename "$f")
    echo "::error::docs/$name does not lead with a 'Full details in SPEC §N' reference. To fix, home this contract prose in SPEC.md and leave a 'Full details in SPEC §N' pointer here (thin-pointer norm)." >&2
    fail=1
  fi
done

exit "$fail"
