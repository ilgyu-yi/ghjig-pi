/**
 * Egress neutralization — relayed platform side effects made inert (SPEC
 * §3.3 "Neutralization"; §3.6's worked application; issue #83 AC2).
 *
 * Runs on its own pattern set — mention shapes are not secret patterns.
 * Each actionable shape is transformed WHOLE to a backtick-wrapped
 * spelling, so republished text cannot page uninvolved parties or drive
 * the platform's auto-close channel (§3.7(e), §3.11's auto-close
 * essential): `@`-mentions, close-keyword + issue-reference pairs in
 * their case and separator variants (whitespace and the colon trailer),
 * `GH-N` forms, URL-form issue references, and cross-repository
 * `owner/repo#N` references.
 *
 * One shape stays live as the recorded decision (§3.3): the bare
 * same-repository `#N` — the pointer idiom §5.1 commits every durable
 * artifact to.
 *
 * The wrap is delimiter-length-aware because CommonMark pairs a code
 * span's opener with the next backtick run of EQUAL length: each pass
 * wraps with a run one backtick longer than the longest run in the text
 * it lands in (recomputed per pass — earlier passes insert backticks),
 * space-padded inside per CommonMark's own padding rule, and separated
 * by a space from any adjacent body backtick, whose touching run would
 * otherwise merge with the delimiter and leave no span. Measured ground
 * for both rules: a fixed single-backtick wrap paired with a stray body
 * backtick and rendered the shape live, and a delimiter touching a body
 * backtick merged runs so no span formed. Entity-encoded spellings are
 * refused as a device here: `&#64;`-style escapes decode back into the
 * text nodes reference filters scan.
 */

/**
 * The wrap passes, in application order: longer shapes first, so the
 * common case of a narrower pattern re-matching inside an already
 * wrapped span does not arise. Where a narrower pattern can still match
 * inside a wrapped shape's text (an `@` inside a URL form), the
 * per-pass delimiter rule makes the double wrap err inert — the outer
 * pair still closes around it.
 */
const WRAP_PASSES: readonly RegExp[] = [
	// URL-form issue references: https://…/issues/N and …/pull/N.
	/https?:\/\/[^\s`]+\/(?:issues|pull)\/\d+/g,
	// Close-keyword + issue-reference pairs, case-insensitive, in both
	// separator spellings — whitespace and the colon trailer (`Fixes: #4`,
	// `fixes:#4`). At least one separator is required: bare `fixes#4`
	// adjacency stays a deliberate non-match (§3.3).
	/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?::\s*|\s+)#\d+/gi,
	// Cross-repository references: owner/repo#N.
	/\b[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+/g,
	// GH-N forms.
	/\bGH-\d+\b/g,
	// @-mentions. \B admits a mention after whitespace or punctuation and
	// excludes an @ preceded by a word character (an address-shaped span).
	/\B@[A-Za-z0-9-]+/g,
];

/** The longest backtick run in `text`, 0 when it carries none. */
function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) {
		if (run.length > longest) {
			longest = run.length;
		}
	}
	return longest;
}

/** The published spelling of `body`: every actionable shape wrapped whole. */
export function neutralizeBody(body: string): string {
	let neutralized = body;
	for (const pass of WRAP_PASSES) {
		// One backtick longer than anything already present, so the wrap's
		// opener pairs with its own closer and never with a body run.
		const delimiter = "`".repeat(longestBacktickRun(neutralized) + 1);
		neutralized = neutralized.replace(pass, (match, offset: number, whole: string) => {
			// A body backtick touching the wrap would merge runs (no span
			// forms), so a space separates the delimiter from it.
			const separatorBefore = offset > 0 && whole[offset - 1] === "`" ? " " : "";
			const afterIndex = offset + match.length;
			const separatorAfter = afterIndex < whole.length && whole[afterIndex] === "`" ? " " : "";
			return `${separatorBefore}${delimiter} ${match} ${delimiter}${separatorAfter}`;
		});
	}
	return neutralized;
}
