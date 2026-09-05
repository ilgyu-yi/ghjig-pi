/**
 * Egress neutralization — relayed platform side effects made inert (SPEC
 * §3.3 "Neutralization"; §3.6's worked application; issue #83 AC2).
 *
 * Runs on its own pattern set — mention shapes are not secret patterns.
 * Each actionable shape is transformed WHOLE to its backtick-wrapped
 * spelling, so republished text cannot page uninvolved parties or drive
 * the platform's auto-close channel (§3.7(e), §3.11's auto-close
 * essential): `@`-mentions, close-keyword + issue-reference pairs in
 * their case variants, `GH-N` forms, URL-form issue references, and
 * cross-repository `owner/repo#N` references.
 *
 * One shape stays live as the recorded decision (§3.3): the bare
 * same-repository `#N` — the pointer idiom §5.1 commits every durable
 * artifact to. And the transform errs inert: a shape already inside
 * backticks may gain a second pair, which changes rendering only, never
 * reactivates a reference.
 */

/**
 * The wrap passes, in application order. Earlier passes claim the longer
 * shapes so a later, narrower pattern never rewrites inside them: the
 * URL form carries no `#N` for the reference passes and no `@` for the
 * mention pass; the close-keyword pair claims its `#N` whole; the
 * cross-repository form claims its `#N` with its `owner/repo` prefix.
 */
const WRAP_PASSES: readonly RegExp[] = [
	// URL-form issue references: https://…/issues/N and …/pull/N.
	/https?:\/\/[^\s`]+\/(?:issues|pull)\/\d+/g,
	// Close-keyword + issue-reference pairs, case-insensitive (§3.3).
	/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#\d+/gi,
	// Cross-repository references: owner/repo#N.
	/\b[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+/g,
	// GH-N forms.
	/\bGH-\d+\b/g,
	// @-mentions. \B admits a mention after whitespace or punctuation and
	// excludes an @ preceded by a word character (an address-shaped span).
	/\B@[A-Za-z0-9-]+/g,
];

/** The published spelling of `body`: every actionable shape wrapped whole. */
export function neutralizeBody(body: string): string {
	let neutralized = body;
	for (const pass of WRAP_PASSES) {
		neutralized = neutralized.replace(pass, "`$&`");
	}
	return neutralized;
}
