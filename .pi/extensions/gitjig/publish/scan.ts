/**
 * Egress secret scan — the committed pattern file's second reader (SPEC
 * §3.3 "egress publish-boundary semantics"; issue #83 AC4).
 *
 * Rule source: `.githooks/helpers/secret-patterns`, resolved from the
 * runtime's own repository root (§4.6) — never a caller-supplied location.
 * Parsed on the file's own format contract: one `id<TAB>ERE` row per line,
 * a trailing CR stripped per row, blank and `#`-leading lines ignored,
 * lowercase-hyphen IDs, EREs constrained to the POSIX-ERE ∩ RegExp common
 * subset so `new RegExp` compiles what the tier-2 engine compiles.
 *
 * Fail posture (§3.9 `egress-publish-patterns`, closed): an unusable rule
 * source — file unreadable, a row failing the format contract, a pattern
 * that does not compile, or a set empty after stripping comments and
 * blanks — throws `PatternSourceError` with a fixed content-free cause.
 * Machinery failure is NOT the out-of-domain disposition: that one is for
 * a body the reading cannot measure, and the caller maps the throw to its
 * own machinery refusal.
 *
 * Measurement pipeline (§3.3, ordered): (1) a NUL-bearing body is
 * out-of-domain; (2) Unicode format characters (category Cf) are stripped
 * before matching — the over-match closure for a split span; (3) matching
 * runs per line over the byte-domain reading of the stripped text (each
 * line's UTF-8 bytes viewed one-byte-one-code-unit), converged with the
 * tier-2 scan's `LC_ALL=C` byte semantics. A refuse-match outcome carries
 * pattern IDs and 1-based line locators and never the matched text (§3.8).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { locateRepoRoot } from "../locate.ts";

/** The committed rule source, relative to the repository root (§3.3). */
const PATTERN_FILE_PARTS = [".githooks", "helpers", "secret-patterns"] as const;

/** Lowercase-hyphen ID tokens, per the pattern file's format contract. */
const ID_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * An unusable rule source (§3.9 `egress-publish-patterns`). The message is
 * a fixed literal — no path, no row content — so a caller may surface it
 * verbatim in a content-free refusal record.
 */
export class PatternSourceError extends Error {}

export type ScanOutcome =
	| { disposition: "clean" }
	| { disposition: "refuse-out-of-domain" }
	| { disposition: "refuse-match"; patternIds: string[]; lines: number[] };

interface CompiledPattern {
	id: string;
	regexp: RegExp;
}

/** Read, parse, and compile the committed set — or throw, never degrade. */
function loadCommittedPatterns(): CompiledPattern[] {
	const path = join(locateRepoRoot(), ...PATTERN_FILE_PARTS);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new PatternSourceError(
			"the committed pattern file is absent or unreadable at the resolved repository root",
		);
	}
	const compiled: CompiledPattern[] = [];
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (/^[ \t]*$/.test(line) || line.startsWith("#")) {
			continue;
		}
		const tab = line.indexOf("\t");
		if (tab === -1 || !ID_SHAPE.test(line.slice(0, tab))) {
			throw new PatternSourceError("a committed pattern row fails the id<TAB>ERE format contract");
		}
		try {
			compiled.push({ id: line.slice(0, tab), regexp: new RegExp(line.slice(tab + 1)) });
		} catch {
			throw new PatternSourceError("a committed pattern does not compile in the common subset");
		}
	}
	if (compiled.length === 0) {
		throw new PatternSourceError("the committed pattern set is empty after stripping comments and blanks");
	}
	return compiled;
}

/**
 * The boundary's measurement, total in the three dispositions above.
 * Throws `PatternSourceError` exactly when the rule source is unusable.
 */
export function scanBody(body: string): ScanOutcome {
	if (body.includes("\u0000")) {
		return { disposition: "refuse-out-of-domain" };
	}
	const stripped = body.replace(/\p{Cf}/gu, "");
	const patterns = loadCommittedPatterns();
	const patternIds: string[] = [];
	const lines: number[] = [];
	stripped.split("\n").forEach((line, index) => {
		// One byte, one code unit: the UTF-8 bytes of the line re-read as
		// latin1, so a multibyte codepoint interrupts a counted class run
		// exactly as it does under the tier-2 engine's byte semantics (§3.3).
		const byteView = Buffer.from(line, "utf8").toString("latin1");
		let matched = false;
		for (const pattern of patterns) {
			if (pattern.regexp.test(byteView)) {
				matched = true;
				if (!patternIds.includes(pattern.id)) {
					patternIds.push(pattern.id);
				}
			}
		}
		if (matched) {
			lines.push(index + 1);
		}
	});
	if (patternIds.length > 0) {
		return { disposition: "refuse-match", patternIds, lines };
	}
	return { disposition: "clean" };
}
