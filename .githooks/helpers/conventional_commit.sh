# .githooks/helpers/conventional_commit.sh — the commit-format class's
# delegated predicate (SPEC §3.3 `commit-format` row; the grammar contract
# `.githooks/_lib.sh` states for this file). Sourced by adapters, never
# executed; defines:
#   check_commit_subject <subject-line>
#
# Grammar: `<type>(#<N>)[!]: <subject>` — the required group
# feat|fix|docs|refactor|perf demands `(#N)`; the optional group
# test|style|build|ci|chore|revert may omit it. The subject after `: ` must
# measure 1..72 codepoints.
#
# Measurement is a total function with exactly two outcomes (§3.9): a valid
# decimal, or a refusal — no consumer reads an unvalidated value. The domain
# is validated BEFORE counting: pure-ASCII input is exact in any charmap
# (codepoints == bytes), so a degraded environment refuses only the inputs
# it would mis-measure; non-ASCII input needs a multibyte-capable measuring
# charmap (the locale's, verified — a byte count over multibyte input is a
# confident wrong decimal, not a measurement) AND bytes valid in that
# charmap (invalid bytes have no codepoint count). Either miss refuses with
# its own arm-named cause.
#
# Causes are content-free constants (§3.9): the arm name plus the measured
# decimal where one exists, never the subject's bytes — `githook_block`
# interpolates raw, and a hostile subject must reach no surface (§3.11's
# hostile-arm terseness). This file emits the CAUSE only; each calling
# surface appends the recovery live at that surface (§3.11's arm-scoped
# remediation — the division `.githooks/commit-msg` states in place).
#
# Fail direction bookkeeping: every refusal below is the LIVE predicate
# refusing the actor's own input (§3.9's measurement rule). Degradation of
# the enforcement chain around this file — binding, helper file, delegated
# function — is the adapters' fail-open business (`githook_source`,
# `githook_require`), inventoried at `.pi/extensions/gitjig/postures.ts`,
# never re-decided here.

# Parsing runs under byte semantics (LC_ALL=C) so globs, lengths, and
# offsets are deterministic over arbitrary bytes — a subject may carry any
# byte, and multibyte-aware bash string ops are undefined over invalid
# sequences. The caller's charmap is captured FIRST: it is the measuring
# charmap the domain check consults, and forcing C would erase it.
check_commit_subject() {
	local _cc_charmap
	_cc_charmap="$(locale charmap 2>/dev/null)" || _cc_charmap=""

	local _cc_lc_set="${LC_ALL+x}" _cc_lc_val="${LC_ALL-}" _cc_status=0
	export LC_ALL=C
	_gitjig_cc_check "${1-}" "$_cc_charmap" "$_cc_lc_val" "${LC_CTYPE-}" "${LANG-}" || _cc_status=$?
	if [ "$_cc_lc_set" = "x" ]; then LC_ALL="$_cc_lc_val"; else unset LC_ALL; fi
	return "$_cc_status"
}

# _gitjig_cc_check <line> <charmap> <caller-LC_ALL> <caller-LC_CTYPE> <caller-LANG>
_gitjig_cc_check() {
	local _cc_line="$1" _cc_charmap="$2" _cc_subject
	local _cc_re_required='^(feat|fix|docs|refactor|perf)\(#[0-9]+\)(!)?: (.*)$'
	local _cc_re_optional='^(test|style|build|ci|chore|revert)(\(#[0-9]+\))?(!)?: (.*)$'

	if [[ "$_cc_line" =~ $_cc_re_required ]]; then
		_cc_subject="${BASH_REMATCH[3]}"
	elif [[ "$_cc_line" =~ $_cc_re_optional ]]; then
		_cc_subject="${BASH_REMATCH[4]}"
	else
		printf '%s\n' 'commit-format: subject line does not match <type>(#<N>)[!]: <subject> (feat|fix|docs|refactor|perf require (#N); test|style|build|ci|chore|revert may omit it)' >&2
		return 1
	fi

	local _cc_length
	_cc_length="$(_gitjig_cc_measure "$_cc_subject" "$_cc_charmap" "$3" "$4" "$5")" || return 1

	if [ "$_cc_length" -lt 1 ] || [ "$_cc_length" -gt 72 ]; then
		printf 'commit-format: subject measures %s codepoints, outside 1..72\n' "$_cc_length" >&2
		return 1
	fi
	return 0
}

# _gitjig_cc_measure <subject> <charmap> <caller-LC_ALL> <caller-LC_CTYPE> <caller-LANG>
# Prints the codepoint count, or refuses (arm-named cause to stderr, no
# stdout) — the two outcomes, nothing else. Runs under LC_ALL=C.
_gitjig_cc_measure() {
	local _cc_subject="$1" _cc_charmap="$2"

	# Pure ASCII (no byte outside 0x01-0x7F; NUL cannot enter a shell
	# variable): codepoints == bytes in any charmap — exact, so a degraded
	# environment never blocks it.
	case "$_cc_subject" in
	*[!$'\001'-$'\177']*) ;;
	*)
		printf '%s\n' "${#_cc_subject}"
		return 0
		;;
	esac

	# Non-ASCII: the measuring charmap must be multibyte-capable. Under any
	# other charmap the bytes' decoding is a guess, and a per-byte count is
	# a confident wrong decimal — refuse, never approve (§3.9).
	case "$_cc_charmap" in
	UTF-8 | utf-8 | UTF8 | utf8) ;;
	*)
		printf '%s\n' 'commit-format: measurement environment cannot count codepoints (charmap not multibyte-capable) — subject length unmeasured, refusing' >&2
		return 1
		;;
	esac

	local _cc_count=""
	if command -v python3 >/dev/null 2>&1; then
		# Decode-then-count in the verified charmap; decode failure is the
		# out-of-domain input shape, exit 3, distinguished from tool failure.
		_cc_count="$(printf '%s' "$_cc_subject" | python3 -c '
import sys
data = sys.stdin.buffer.read()
try:
    print(len(data.decode("utf-8")))
except UnicodeDecodeError:
    sys.exit(3)
' 2>/dev/null)"
		local _cc_rc=$?
		if [ "$_cc_rc" -eq 3 ]; then
			printf '%s\n' 'commit-format: subject bytes are not valid in the measuring charmap — no codepoint count exists, refusing' >&2
			return 1
		fi
		if [ "$_cc_rc" -ne 0 ]; then
			printf '%s\n' 'commit-format: measurement environment cannot count codepoints (counting tool failed) — subject length unmeasured, refusing' >&2
			return 1
		fi
	elif command -v wc >/dev/null 2>&1 && command -v iconv >/dev/null 2>&1; then
		# Fallback: `wc -m` under the caller's verified-UTF-8 locale, with
		# two domain checks a bare count skips. (1) Calibration: a known
		# 3-byte, 1-codepoint probe (EURO SIGN, octal-escaped) must measure
		# 1 — a byte-counting `wc -m` is the degradation shape, not a
		# measurer. (2) Validity: bytes must round-trip the charmap, else
		# the count that follows would be a decimal over undefined input.
		local _cc_probe
		_cc_probe="$(printf '\342\202\254' | LC_ALL="$3" LC_CTYPE="$4" LANG="$5" wc -m 2>/dev/null)" || _cc_probe=""
		_cc_probe="${_cc_probe//[[:space:]]/}"
		if [ "$_cc_probe" != "1" ]; then
			printf '%s\n' 'commit-format: measurement environment cannot count codepoints (counter is byte-counting) — subject length unmeasured, refusing' >&2
			return 1
		fi
		if ! printf '%s' "$_cc_subject" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
			printf '%s\n' 'commit-format: subject bytes are not valid in the measuring charmap — no codepoint count exists, refusing' >&2
			return 1
		fi
		_cc_count="$(printf '%s' "$_cc_subject" | LC_ALL="$3" LC_CTYPE="$4" LANG="$5" wc -m 2>/dev/null)" || _cc_count=""
		_cc_count="${_cc_count//[[:space:]]/}"
	else
		printf '%s\n' 'commit-format: measurement environment cannot count codepoints (no capable counting tool) — subject length unmeasured, refusing' >&2
		return 1
	fi

	# No consumer reads an unvalidated value (§3.9): anything but a bare
	# decimal is a failed measurement, whatever the tool's exit said.
	case "$_cc_count" in
	'' | *[!0-9]*)
		printf '%s\n' 'commit-format: measurement environment cannot count codepoints (count not a decimal) — subject length unmeasured, refusing' >&2
		return 1
		;;
	esac
	printf '%s\n' "$_cc_count"
	return 0
}
