# .githooks/helpers/secret_scan.sh — the staged-secret class's delegated
# scan (SPEC §3.3 secret row + staged-scan semantics statement; the
# interface contract `.githooks/_lib.sh` states for this file). Sourced by
# adapters, never executed; defines:
#   scan_staged_secrets
#
# Rule source: the committed pattern file `secret-patterns`, resolved from
# THIS file's own installed position (`BASH_SOURCE[0]`, inside the function,
# so the derivation stays function-local) — the bytes both readers must
# agree on are the committed repo file (§3.3's single-source rule), and the
# rule set travels with the helper set the adapters actually sourced rather
# than with a directory name spelled against the repository top. Format and
# the compatible-extension-only rule live in that file's header.
#
# Measurement domain (§3.3): the added text lines of the staged diff, per
# staged path — paths from `git diff --cached --name-only -z`, each then
# addressed with a `:(literal)` pathspec; content read config-neutrally
# (`--no-ext-diff --no-textconv --no-color -U0`) and env-neutrally (the
# pathspec-magic env family is unset around every git-diff child — see
# _gitjig_ss_git_diff); added lines identified
# structurally from the diff's own hunk shape (a content line beginning
# `++` is content, not a header). Binary is keyed by the numstat
# no-line-counts outcome, never a prose message (§3.10). The first commit
# of an unborn HEAD diffs against the empty tree, keyed by outcome. The
# matcher is the hook interpreter's own ERE engine (`[[ =~ ]]`) under
# LC_ALL=C byte semantics — no PATH-resolved external matcher enters the
# verdict path.
#
# Outcomes (§3.3's three-disposition split under §3.9):
#   - machinery degradation (pattern file absent/unreadable, an up-front
#     pattern-validation failure, a set empty after stripping) → the scan
#     disarms for the run with exactly one not-enforced audit warn record
#     and allows — never a refusal of the actor's input;
#   - unmeasurable input (binary by the numstat outcome, unrenderable
#     staged content, an empty per-path measurement for a path the
#     enumeration itself listed, a matcher failure at scan time over one
#     input) → refused on its own content-free cause, distinct from a
#     pattern match;
#   - pattern match → refused; the record carries the pattern ID and the
#     SANITIZED path and never the matched bytes or raw path bytes (§3.8).
#
# Path sanitization (stated choice): every byte outside printable ASCII,
# plus '%' itself and the single quote (the record's own path-field
# delimiter), is percent-encoded (%XX, uppercase hex) before the path
# reaches any record sink — `githook_block` and `audit_log` interpolate
# raw, and a hostile filename must not split a record or forge its fields.
#
# Allow-list: the repo-root `.shellsecretignore` is domain exclusion, never
# approval — literal or shell-glob lines, `#` comments, absent means empty;
# a present-but-unreadable list emits one degradation warn record and the
# scan proceeds with NO exclusions (it fails to excuse; it never approves
# unmeasured). Suppression by a line that MATCHES is silent on every
# surface, including a `*` line that excludes every staged path: the
# machinery degradations above print because nobody chose them, and this
# list is the operator's own working-tree choice, tracked or not — a record
# per suppressed path would be one per commit per path on any repository
# with a broad list.
#
# This file emits the CAUSE only; each calling surface appends the recovery
# live at that surface (§3.11's arm-scoped remediation). Every git child
# reads stdin from /dev/null (the adapter loop precedent). Fail-direction
# bookkeeping lives in the one inventory at
# `.pi/extensions/gitjig/postures.ts`, never re-decided here.
#
# Env-trust note (the branch_guard.sh `unset -v` precedent): this file
# keeps NO file-scope `_GITJIG_SS_*` state — every variable below is
# function-local, so there is no inherited cell for a caller's environment
# to pre-seed and nothing to discard at source time.

# _gitjig_ss_sanitize_path <raw-path> — print the percent-encoded rendering
# (C-locale byte loop; printable ASCII except '%' passes through).
_gitjig_ss_sanitize_path() {
	local LC_ALL=C
	local _ss_in="$1" _ss_out='' _ss_i=0 _ss_len _ss_ch _ss_ord
	_ss_len=${#_ss_in}
	while [ "$_ss_i" -lt "$_ss_len" ]; do
		_ss_ch="${_ss_in:$_ss_i:1}"
		case "$_ss_ch" in
		'%') _ss_out="${_ss_out}%25" ;;
		# The single quote is the record's own path-field delimiter: raw, it
		# would terminate the quoted field early and forge its boundary.
		\') _ss_out="${_ss_out}%27" ;;
		[[:print:]]) _ss_out="${_ss_out}${_ss_ch}" ;;
		*)
			# The ordinal is masked to one byte before rendering: bash 3.2's
			# printf sign-extends "'<byte>" for bytes >= 0x80, and the stated
			# contract is one uppercase %XX per byte.
			printf -v _ss_ord '%d' "'$_ss_ch"
			printf -v _ss_ch '%%%02X' "$((_ss_ord & 0xFF))"
			_ss_out="${_ss_out}${_ss_ch}"
			;;
		esac
		_ss_i=$((_ss_i + 1))
	done
	printf '%s\n' "$_ss_out"
}

# _gitjig_ss_disarm <reason-constant> — machinery degradation: exactly one
# not-enforced warn record AND one stderr line for the run, then the caller
# allows (§3.9). Without the line this arm's allow is byte-identical on both
# streams to an enforced pass — the disarmed allow §3.9 forbids to read like
# an enforced one. It stays one line for the run, not one per suppressed
# path: the record already carries the reason, and the caller appends its
# own recovery.
_gitjig_ss_disarm() {
	printf '%s\n' "[dev-shell] staged-secret scan not enforced: $1 - this commit was not scanned" >&2
	if command -v audit_log >/dev/null 2>&1; then
		( audit_log warn secret not-enforced "staged-secret scan not enforced: $1" ) </dev/null >/dev/null 2>&1 || true
	fi
	return 0
}

# _gitjig_ss_refuse_match <pattern-id> <raw-path> — pattern-match refusal:
# pattern ID + sanitized path on both surfaces, never the matched bytes.
_gitjig_ss_refuse_match() {
	local _ss_id="$1" _ss_sp
	_ss_sp="$(_gitjig_ss_sanitize_path "$2")"
	printf '%s\n' "secret-scan: pattern '${_ss_id}' matched in staged path '${_ss_sp}' — refusing the commit" >&2
	if command -v audit_log >/dev/null 2>&1; then
		( audit_log block secret blocked "secret-scan: pattern '${_ss_id}' matched in staged path '${_ss_sp}'" ) </dev/null >/dev/null 2>&1 || true
	fi
	return 1
}

# _gitjig_ss_refuse_unmeasurable <raw-path> — the unmeasurable-input arm
# (§3.9's measurement rule): its own cause, no pattern ID, content-free.
_gitjig_ss_refuse_unmeasurable() {
	local _ss_sp
	_ss_sp="$(_gitjig_ss_sanitize_path "$1")"
	printf '%s\n' "secret-scan: staged path '${_ss_sp}' has unmeasurable added content — refusing the commit" >&2
	if command -v audit_log >/dev/null 2>&1; then
		( audit_log block secret blocked "secret-scan: unmeasurable added content at staged path '${_ss_sp}'" ) </dev/null >/dev/null 2>&1 || true
	fi
	return 1
}

# _gitjig_ss_git_diff <args…> — every staged-diff read goes through here:
# the pathspec-magic env family is neutralized for the child, because an
# inherited GIT_*_PATHSPECS cell rewrites how the `:(literal)` pathspec
# (and the enumeration it must agree with) is parsed — the measured object
# is no more the environment's to rewrite than it is the clone config's
# (§3.3's measurement-domain rule). Replace-object grafting is disabled on
# the same ground: a local refs/replace ref resolves HEAD to a graft of
# the actor's choosing, and a graft carrying the staged bytes empties the
# measured diff. Subshell form, bash-3.2-safe.
_gitjig_ss_git_diff() {
	(
		unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
		GIT_NO_REPLACE_OBJECTS=1
		export GIT_NO_REPLACE_OBJECTS
		exec git diff "$@"
	)
}

# _gitjig_ss_scan_path <raw-path> — scan one staged path's added lines.
# Reads the caller's _ss_base/_ss_n/_ss_ids/_ss_eres via dynamic scope.
# Returns 0 (clean) or 1 (refused; the record is already emitted).
_gitjig_ss_scan_path() {
	local _ss_p="$1"
	local _ss_num _ss_first _ss_add _ss_rest _ss_del
	if ! _ss_num="$(_gitjig_ss_git_diff --cached --no-ext-diff --no-textconv --no-color --numstat "$_ss_base" -- ":(literal)$_ss_p" 2>/dev/null </dev/null)"; then
		_gitjig_ss_refuse_unmeasurable "$_ss_p"
		return 1
	fi
	if [ -z "$_ss_num" ]; then
		# The enumeration itself just listed this path, so an empty per-path
		# numstat is a measurement the scan did not get — never evidence of
		# no change. Vouching here would approve unmeasured (§3.9): any
		# interference between the two reads lands as a loud refusal.
		_gitjig_ss_refuse_unmeasurable "$_ss_p"
		return 1
	fi
	# Binary is the numstat no-line-counts outcome: "-<TAB>-<TAB>..." (§3.10).
	_ss_first="${_ss_num%%$'\n'*}"
	_ss_add="${_ss_first%%$'\t'*}"
	_ss_rest="${_ss_first#*$'\t'}"
	_ss_del="${_ss_rest%%$'\t'*}"
	if [ "$_ss_add" = "-" ] && [ "$_ss_del" = "-" ]; then
		_gitjig_ss_refuse_unmeasurable "$_ss_p"
		return 1
	fi
	local _ss_diff
	if ! _ss_diff="$(_gitjig_ss_git_diff --cached --no-ext-diff --no-textconv --no-color -U0 "$_ss_base" -- ":(literal)$_ss_p" 2>/dev/null </dev/null)"; then
		_gitjig_ss_refuse_unmeasurable "$_ss_p"
		return 1
	fi
	# Structural hunk parse: only lines after a hunk header are body lines,
	# and only body lines beginning '+' are added content — so a '+++'
	# file header (before any hunk) is never dropped by a prefix guess,
	# and a content line beginning '++' is kept as content.
	local _ss_in_hunk=0 _ss_dline _ss_added _ss_i _ss_rc
	while IFS= read -r _ss_dline; do
		case "$_ss_dline" in
		@@*)
			_ss_in_hunk=1
			continue
			;;
		esac
		[ "$_ss_in_hunk" -eq 1 ] || continue
		case "$_ss_dline" in
		+*) _ss_added="${_ss_dline#+}" ;;
		*) continue ;;
		esac
		_ss_i=0
		while [ "$_ss_i" -lt "$_ss_n" ]; do
			[[ "$_ss_added" =~ ${_ss_eres[$_ss_i]} ]]
			_ss_rc=$?
			if [ "$_ss_rc" -eq 0 ]; then
				_gitjig_ss_refuse_match "${_ss_ids[$_ss_i]}" "$_ss_p"
				return 1
			elif [ "$_ss_rc" -ne 1 ]; then
				# A matcher failure at scan time over one input is the
				# input side of the timing split (§3.3), never a disarm.
				_gitjig_ss_refuse_unmeasurable "$_ss_p"
				return 1
			fi
			_ss_i=$((_ss_i + 1))
		done
	done <<<"$_ss_diff"
	return 0
}

# scan_staged_secrets — the delegated predicate. Returns 0 to allow,
# non-zero to refuse (the adapter appends its own recovery line).
scan_staged_secrets() {
	# LC_ALL=C for the run: [[ =~ ]] matches under byte semantics (§3.3's
	# pinned matcher). Function-local, restored on return.
	local LC_ALL=C
	local _ss_top _ss_pf _ss_home
	_ss_top="$(git rev-parse --show-toplevel 2>/dev/null </dev/null)" || _ss_top=""
	if [ -z "$_ss_top" ]; then
		_gitjig_ss_disarm 'repository toplevel unresolvable'
		return 0
	fi

	# Up-front pattern validation — machinery for the WHOLE run (§3.10's
	# valid-AND-non-empty rule): any invalid row disarms before any path
	# is scanned; a valid neighbour row never turns a partial scan.
	# An unresolvable installed position leaves `_ss_home` empty and the
	# pattern path `/secret-patterns`, which the next test disarms on as
	# `pattern file absent or unreadable` — the same enumerated outcome, one
	# less cause constant to keep in two artifacts and a test arm.
	_ss_home="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || _ss_home=""
	_ss_pf="$_ss_home/secret-patterns"
	if [ ! -f "$_ss_pf" ] || [ ! -r "$_ss_pf" ]; then
		_gitjig_ss_disarm 'pattern file absent or unreadable'
		return 0
	fi
	local _ss_ids _ss_eres
	local _ss_n=0 _ss_bad=0 _ss_row _ss_id _ss_ere _ss_stripped
	local _ss_id_re='^[a-z][a-z0-9-]*$'
	while IFS= read -r _ss_row || [ -n "$_ss_row" ]; do
		# A trailing carriage return is a checkout-smudge artifact
		# (core.autocrlf), not row content: unstripped it rides the ERE,
		# which then compiles cleanly yet can never match an LF-terminated
		# added line — an armed-looking scan that checks nothing (§3.10).
		_ss_row="${_ss_row%$'\r'}"
		case "$_ss_row" in
		'#'*) continue ;;
		esac
		_ss_stripped="${_ss_row//[$' \t']/}"
		[ -n "$_ss_stripped" ] || continue
		case "$_ss_row" in
		*$'\t'*) : ;;
		*)
			_ss_bad=1
			break
			;;
		esac
		_ss_id="${_ss_row%%$'\t'*}"
		_ss_ere="${_ss_row#*$'\t'}"
		if ! [[ "$_ss_id" =~ $_ss_id_re ]] || [ -z "$_ss_ere" ]; then
			_ss_bad=1
			break
		fi
		# ERE compile probe against the empty string, keyed by outcome:
		# 0/1 = compiled (match/no match), anything else = regcomp failure.
		[[ '' =~ $_ss_ere ]]
		case "$?" in
		0 | 1) : ;;
		*)
			_ss_bad=1
			break
			;;
		esac
		_ss_ids[$_ss_n]="$_ss_id"
		_ss_eres[$_ss_n]="$_ss_ere"
		_ss_n=$((_ss_n + 1))
	done <"$_ss_pf"
	if [ "$_ss_bad" -ne 0 ]; then
		_gitjig_ss_disarm 'pattern file failed up-front validation'
		return 0
	fi
	if [ "$_ss_n" -eq 0 ]; then
		_gitjig_ss_disarm 'pattern set empty after stripping comments and blanks'
		return 0
	fi

	# Diff base, keyed by outcome (§3.3): a born HEAD diffs against HEAD,
	# an unborn HEAD against the empty tree — never a guess.
	local _ss_base
	if git rev-parse -q --verify 'HEAD^{commit}' >/dev/null 2>&1 </dev/null; then
		_ss_base=HEAD
	else
		_ss_base="$(git hash-object -t tree /dev/null 2>/dev/null </dev/null)" || _ss_base=""
		if [ -z "$_ss_base" ]; then
			_gitjig_ss_disarm 'staged-diff base unresolvable'
			return 0
		fi
	fi
	# Single-read enumeration, spooled to a temp file: the scan loop below
	# reads the same bytes whose exit status was checked here. A second
	# enumeration inside a process substitution would fail invisibly —
	# streaming an empty list and allowing with zero records, the silent
	# shape §3.9's degradation-signal rule forbids. Spool home: the
	# repository's own git dir first (writable at commit time), the ambient
	# temp dir as fallback — an inherited TMPDIR must not become a disarm
	# lever (§3.3's env-neutrality ground, via the spool rather than the
	# diff). The base is `--`-terminated: a worktree file named HEAD would
	# otherwise make the argv ambiguous, and an enumeration failure is the
	# machinery arm — a disarm any actor could mint with one file.
	local _ss_list _ss_gd
	_ss_gd="$(git rev-parse --git-dir 2>/dev/null </dev/null)" || _ss_gd=""
	_ss_list=""
	if [ -n "$_ss_gd" ] && [ -d "$_ss_gd" ]; then
		_ss_list="$(mktemp "$_ss_gd/gitjig-secret-scan.XXXXXX" 2>/dev/null </dev/null)" || _ss_list=""
	fi
	if [ -z "$_ss_list" ]; then
		_ss_list="$(mktemp "${TMPDIR:-/tmp}/gitjig-secret-scan.XXXXXX" 2>/dev/null </dev/null)" || _ss_list=""
	fi
	if [ -z "$_ss_list" ]; then
		_gitjig_ss_disarm 'staged-path enumeration spool unavailable'
		return 0
	fi
	if ! _gitjig_ss_git_diff --cached --name-only -z "$_ss_base" -- >"$_ss_list" 2>/dev/null </dev/null; then
		rm -f -- "$_ss_list"
		_gitjig_ss_disarm 'staged path enumeration failed'
		return 0
	fi

	# Allow-list: domain exclusion, never approval (§3.3).
	local _ss_ign="$_ss_top/.shellsecretignore" _ss_excl _ss_excl_n=0 _ss_line
	if [ -f "$_ss_ign" ]; then
		if [ -r "$_ss_ign" ]; then
			while IFS= read -r _ss_line || [ -n "$_ss_line" ]; do
				# Same CR strip as the pattern rows: a CRLF-edited list must
				# excuse what it names, not fail-closed on an invisible byte.
				_ss_line="${_ss_line%$'\r'}"
				case "$_ss_line" in
				'' | '#'*) continue ;;
				esac
				_ss_excl[$_ss_excl_n]="$_ss_line"
				_ss_excl_n=$((_ss_excl_n + 1))
			done <"$_ss_ign"
		else
			if command -v audit_log >/dev/null 2>&1; then
				( audit_log warn secret allowlist-unreadable '.shellsecretignore is present but unreadable: the scan proceeds with no exclusions (it fails to excuse, never approves unmeasured)' ) </dev/null >/dev/null 2>&1 || true
			fi
		fi
	fi

	local _ss_path _ss_e _ss_skip _ss_verdict=0
	while IFS= read -r -d '' _ss_path; do
		_ss_skip=0
		_ss_e=0
		while [ "$_ss_e" -lt "$_ss_excl_n" ]; do
			# Literal or shell glob per line (unquoted pattern on purpose).
			case "$_ss_path" in
			${_ss_excl[$_ss_e]})
				_ss_skip=1
				break
				;;
			esac
			_ss_e=$((_ss_e + 1))
		done
		if [ "$_ss_skip" -eq 0 ]; then
			if ! _gitjig_ss_scan_path "$_ss_path"; then
				_ss_verdict=1
				break
			fi
		fi
	done <"$_ss_list"
	rm -f -- "$_ss_list"
	return "$_ss_verdict"
}
