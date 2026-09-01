#!/usr/bin/env bash
#
# check-changelog.sh — the changelog fragment-gate predicate (issue #43).
#
# The body the `fragment-gate` job calls. It is driven entirely through two
# seams, so it is runnable without network, `gh`, or a repository checkout:
#
#   printf '%s' "$FILES_JSON" | bash check-changelog.sh \
#     --pr <n> --expected-count <n> --allowed "<stems>" --root <dir>
#
#   stdin            the JSON `gh api --paginate --slurp
#                    .../pulls/N/files?per_page=100` produces: an array of
#                    pages, each page an array of file objects (flatten
#                    `.[][]`). Objects carry `filename`, `status`, and for
#                    renames `previous_filename`.
#   --pr             the pull request number, for message text.
#   --expected-count the PR's `changedFiles`, an independent count of the
#                    listing's expected length.
#   --allowed        whitespace-separated fragment stems in one argument:
#                    the PR number union its closing-issue numbers.
#   --root           the directory fragment paths resolve against when their
#                    content is read. Annotations keep the repo-relative path
#                    so they still resolve on the platform.
#
# Exit 0 = pass, exit 1 = block. No third code is in the contract.
#
# The predicate is SPEC §1.3's floor over the NET file listing, in two
# independent clauses, preceded by three fail-closed arms:
#
#   Fail-closed  An empty payload (the gate was handed no listing to read), a
#                flattened length disagreeing with --expected-count
#                (truncation), and a `status` outside the known set. Each
#                carries its own message, so an unread payload is never
#                reported as a truncated one; and all three stay
#                distinguishable from clause 1, so a transport-shaped failure
#                is never reported as "the author forgot a fragment".
#   Clause 1     Existential, permissive. At least one non-`removed` entry of
#                fragment shape, in the allow-set, with valid content. A
#                fragment that fails it is merely not a witness.
#   Clause 2     Universal, no-junk. Every `added`/`renamed`/`copied` entry of
#                fragment shape is valid; one valid fragment never excuses a
#                malformed sibling. A re-categorising move — an `added` stem
#                that also appears among the listing's `removed` fragment
#                stems, or a `renamed` entry from one fragment path to another
#                leaving the stem unchanged — is exempt from the allow-set
#                rule ALONE, because that stem was in the allow-set of the PR
#                that first added the fragment. Presence, bullet form, the
#                same-line (#N) ref and the positive-stem rule all still run
#                on it, so a move cannot carry a content rewrite past the
#                clause, and a rename from outside changelog_unreleased/ is
#                an addition rather than a re-categorisation.
#
# Residual — what this gate deliberately leaves unreached (§3.11), so each
# gap reads as a decision rather than an oversight:
#
#   1. A `modified` fragment's content is not validated for form. §1.3's
#      second clause binds added fragments; a weaker second predicate over a
#      class the floor does not bind would be a divergence surface.
#      Review-enforced.
#   2. A `removed` fragment is not gated. Emptying the tree is the release
#      backbone's own act.
#   3. Exactly-one is not enforced. §1.3 keeps that above the CI floor;
#      review-enforced.
#   4. Category correctness and bullet truthfulness are not judged — no
#      machine reading distinguishes `fixed` from `changed`, or a true bullet
#      from a plausible one.
#   5. `copied` is classified but unexercised by the suite; the platform is
#      unlikely to emit it for this tree.
#   6. A pull request at the platform's file-listing ceiling. `changedFiles`
#      is a GraphQL count while the Files API caps at 3000, so the two do not
#      share a ceiling and the truncation comparison does detect real
#      truncation.
#   7. The `skip-changelog` label step's own `gh pr view` is un-armed under
#      `set -euo pipefail`: a transport failure there fails the job with no
#      message. Pre-existing, and out of this change's scope.
#   8. Merge-ref versus head skew. `actions/checkout` on `pull_request`
#      checks out the merge commit while the listing is merge-base..head, so
#      a fragment landed concurrently on the base is present in the checkout
#      and correctly not validated.

set -euo pipefail

PR=""
EXPECTED=""
ALLOWED=""
ROOT="."

while [ $# -gt 0 ]; do
	case "$1" in
		--pr)
			PR=${2:-}
			shift 2
			;;
		--expected-count)
			EXPECTED=${2:-}
			shift 2
			;;
		--allowed)
			ALLOWED=${2:-}
			shift 2
			;;
		--root)
			ROOT=${2:-}
			shift 2
			;;
		*)
			echo "::error::check-changelog: unrecognized argument '$1'. Usage: check-changelog.sh --pr <n> --expected-count <n> --allowed '<stems>' --root <dir>" >&2
			exit 1
			;;
	esac
done

# `--allowed` is required alongside the other two. An absent allow-set is not
# an empty one: every stem would fail the allow-set rule and the gate would
# blame the author for a transport-shaped omission, offering two recoveries
# that cannot clear it.
if [ -z "$PR" ] || [ -z "$EXPECTED" ] || [ -z "$ALLOWED" ]; then
	echo "::error::check-changelog: --pr, --expected-count and --allowed are all required. Usage: check-changelog.sh --pr <n> --expected-count <n> --allowed '<stems>' --root <dir>" >&2
	exit 1
fi

# The fragment path shape, from changelog_unreleased/TEMPLATE.md.
FRAGMENT_RE='^changelog_unreleased/(added|changed|deprecated|removed|fixed|security)/[0-9]+\.md$'

is_fragment() {
	printf '%s' "$1" | grep -qE "$FRAGMENT_RE"
}

stem_of() {
	local base=${1##*/}
	printf '%s' "${base%.md}"
}

# Prints the first defect of the fragment at `$1` (stem `$2`) and returns 1;
# returns 0 silently when the fragment is valid. Clause 1 calls it for its
# verdict only; clause 2 turns the printed defect into an annotation.
#
# `$3` = 1 waives the allow-set rule and nothing else. Clause 2's move
# exemption is its only caller with 1: every other rule keeps running on an
# exempt entry.
fragment_defect() {
	local path=$1
	local stem=$2
	local waive_allow_set=${3:-0}
	local file="$ROOT/$path"

	case "$stem" in
		0 | 0*)
			printf '%s' "Filename stem must be a positive integer with no leading zero (got '$stem')."
			return 1
			;;
	esac

	# Checked before any read, so a path in the listing but not in the
	# checkout is refused for the reason it was actually refused rather than
	# by a shell "No such file" leaking out of grep.
	if [ ! -f "$file" ]; then
		printf '%s' "Fragment is listed as part of this PR but is not present in the checkout at this path. If the listing and the checkout disagree, re-run the job."
		return 1
	fi

	if ! grep -qE '^- ' "$file"; then
		printf '%s' "Fragment must be a single-line markdown bullet beginning with '- '. See changelog_unreleased/TEMPLATE.md."
		return 1
	fi

	# The bullet and the (#<stem>) ref must co-occur on ONE line: two
	# line-independent checks let a `- ` bullet on one line and a `(#N)` ref
	# on another pass both.
	if ! grep -qE "^- .*\(#${stem}\)" "$file"; then
		printf '%s' "Fragment bullet line must contain (#${stem}) matching the filename stem on the SAME line (single-line '- ... (#${stem})'). See changelog_unreleased/TEMPLATE.md."
		return 1
	fi

	if [ "$waive_allow_set" != 1 ] && ! printf '%s\n' $ALLOWED | grep -qx "$stem"; then
		printf '%s' "Filename stem '$stem' is neither this PR's number (${PR}) nor in closingIssuesReferences. Rename the file to match, or update the PR's Closes/Refs to include #${stem}."
		return 1
	fi

	return 0
}

payload=$(cat)

# Fail-closed arm 0 — an empty payload, refused as one. jq reads empty (or
# blank) input as no document at all and exits 0, so both the listing and the
# length below come back blank; without this arm the truncation arm renders
# "returned  file entries" and asserts a partial view of a listing the gate
# never read. Distinct message, distinct cause.
if [ -z "${payload//[[:space:]]/}" ]; then
	echo "::error::The gate was handed an empty PR file listing on stdin, so it read no entries at all. This is a transport failure, not truncation, and NOT a missing-fragment failure; re-run the job." >&2
	exit 1
fi

# Splits one @tsv row into its three fields by position. `IFS=$'\t' read` is
# unusable here: tab is IFS whitespace, so a row whose leading field is empty
# (an entry the platform sent with no `status`) has that field elided and
# every later field shifts left — which made the refusal name the filename as
# the bad status and the status as the empty filename. @tsv escapes any tab
# inside a value, so splitting on literal tabs is exact.
split_row() {
	local row=$1
	local rest
	status=${row%%$'\t'*}
	rest=${row#*$'\t'}
	filename=${rest%%$'\t'*}
	previous=${rest#*$'\t'}
}

# One TSV row per file entry: status, filename, previous_filename.
if ! listing=$(printf '%s' "$payload" | jq -r '[.[][]] | .[] | [(.status // ""), (.filename // ""), (.previous_filename // "")] | @tsv' 2>/dev/null); then
	echo "::error::The PR file listing on stdin is not the paginated shape this gate reads, so it could not be classified. This is NOT a missing-fragment failure; re-run the job." >&2
	exit 1
fi

if ! total=$(printf '%s' "$payload" | jq -r '[.[][]] | length' 2>/dev/null); then
	echo "::error::The PR file listing on stdin is not the paginated shape this gate reads, so it could not be counted. This is NOT a missing-fragment failure; re-run the job." >&2
	exit 1
fi

# Fail-closed arm 1 — truncation. `changedFiles` is counted by a different
# platform surface than the Files API listing, so a disagreement means the
# gate is reading a partial view and must not judge on it.
if [ "$total" != "$EXPECTED" ]; then
	echo "::error::The PR file listing is incomplete: the platform returned ${total} file entries but the PR reports ${EXPECTED} changed files. The gate will not judge a partial view. This is NOT a missing-fragment failure; re-run the job." >&2
	exit 1
fi

# Fail-closed arm 2 — status classification, by equality. Substring matching
# would read an unknown "add" as "added" and judge on it.
added_count=0
removed_stems=""
while IFS= read -r row; do
	split_row "$row"
	if [ -z "$status" ] && [ -z "$filename" ]; then
		continue
	fi
	case "$status" in
		added | removed | modified | renamed | copied | changed | unchanged) ;;
		*)
			# Two causes reach here and only one of them is transient, so the
			# refusal names a recovery for each rather than the one that is
			# dead for the cause that will actually produce it.
			echo "::error::Unrecognized file status '${status}' for '${filename}' in the PR file listing, so the entry could not be classified. This is NOT a missing-fragment failure. Two causes reach this arm: a partial entry from the platform, which is transient — re-run the job; or a new status in the platform's enum, which re-running can never clear — apply the 'skip-changelog' label to unblock this PR, then add the status to the known set in .github/workflows/check-changelog.sh." >&2
			exit 1
			;;
	esac
	if [ "$status" = "added" ]; then
		added_count=$((added_count + 1))
	fi
	if [ "$status" = "removed" ] && is_fragment "$filename"; then
		removed_stems="${removed_stems}$(stem_of "$filename")
"
	fi
done <<< "$listing"

# Clause 2 — universal no-junk. Every offender is annotated in one run, then
# the gate fails after the loop.
bad=0
while IFS= read -r row; do
	split_row "$row"
	if [ -z "$filename" ]; then
		continue
	fi
	case "$status" in
		added | renamed | copied) ;;
		*) continue ;;
	esac
	if ! is_fragment "$filename"; then
		continue
	fi
	stem=$(stem_of "$filename")

	# Move exemption — a re-categorisation of an already-merged fragment, in
	# either shape the platform may report it. It waives the allow-set rule
	# and nothing else: the stem was in the allow-set of the PR that first
	# added the fragment, so re-checking it against this PR's would refuse a
	# move §1.3's floor permits — but content, presence, bullet form, the
	# same-line (#N) ref and the positive-stem rule keep running, so the move
	# cannot smuggle an arbitrary rewrite past the clause.
	#
	# The `renamed` arm requires the PREVIOUS path to be a fragment too. A
	# rename into changelog_unreleased/ from anywhere else was never validated
	# by this gate, so it is an addition and carries an addition's burden;
	# comparing basename stems alone would exempt it.
	exempt=0
	if [ "$status" = "added" ] && printf '%s' "$removed_stems" | grep -qx "$stem"; then
		exempt=1
	fi
	if [ "$status" = "renamed" ] && [ -n "$previous" ] && is_fragment "$previous" &&
		[ "$(stem_of "$previous")" = "$stem" ]; then
		exempt=1
	fi

	if ! defect=$(fragment_defect "$filename" "$stem" "$exempt"); then
		echo "::error file=${filename}::${defect}" >&2
		bad=1
	fi
done <<< "$listing"

if [ "$bad" = 1 ]; then
	echo "::error::One or more fragments added, renamed or copied by this PR failed validation. Every added, renamed or copied fragment must satisfy all rules (positive-integer stem, leading '- ' bullet, (#<N>) ref matching the stem on the same line, stem in the PR/issue allow-set) — one valid fragment does not excuse a malformed sibling. See changelog_unreleased/TEMPLATE.md." >&2
	exit 1
fi

# Clause 1 — existential floor. A `removed` entry is never a witness and is
# never read: at PR head it is not on disk.
witness=""
while IFS= read -r row; do
	split_row "$row"
	if [ -z "$filename" ]; then
		continue
	fi
	case "$status" in
		added | modified | renamed | copied | changed) ;;
		*) continue ;;
	esac
	if ! is_fragment "$filename"; then
		continue
	fi
	if fragment_defect "$filename" "$(stem_of "$filename")" > /dev/null; then
		witness=$filename
		break
	fi
done <<< "$listing"

if [ -z "$witness" ]; then
	echo "::error::No fragment in this PR's net file listing satisfies the changelog floor. Expected at least one file under changelog_unreleased/<category>/<N>.md, present at PR head, whose stem is this PR's number (${PR}) or one of its closing issue numbers, and whose bullet matches changelog_unreleased/TEMPLATE.md. Add one, or apply the 'skip-changelog' label if this PR has no end-user observable change." >&2
	exit 1
fi

echo "check-changelog: net PR file listing — ${total} file(s), ${added_count} added."
exit 0
