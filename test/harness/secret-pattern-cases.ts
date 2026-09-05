/**
 * Shared secret-pattern conformance case set (issue #83 AC4; SPEC §3.3's
 * egress rule-source clause). This module is the convergence lock §3.11's
 * converged-implementations clause asks for: the two readers of the one
 * committed pattern file — the tier-2 bash scanner (`scan_staged_secrets`)
 * and the egress consumer (`.pi/extensions/gitjig/publish/scan.ts`) —
 * cannot literally share code, so both are run against THIS one case set
 * by `test/egress-conformance.unit.test.ts`.
 *
 * WHAT THIS MODULE DOES NOT ESTABLISH. It is data plus a parser of the
 * committed pattern file — it runs no reader and proves nothing by itself.
 * A case's `tier2`/`egress` fields are EXPECTED dispositions; the suites
 * that drive each reader are what turn them into claims. The per-reader
 * divergences recorded here are the SPEC's own (§3.3): they are deliberate
 * and enumerated, so agreement between the readers is asserted everywhere
 * EXCEPT where a case declares the divergence.
 *
 * Environment constraint (the secret-scan.githook.test.ts precedent):
 * every secret-shaped fragment and every control byte is BUILT AT RUNTIME
 * from codepoint constants and concatenation, never written literally — a
 * literal secret-shaped string in this source would trip the development
 * shell's own staged-secret matcher the moment this file is committed, and
 * a literal control byte cannot ride a Bash command inline (measured; the
 * issue #83 Doc-phase probes). The asserted sequences exist only at
 * runtime, which also keeps byte-absence assertions honest.
 *
 * Divergence table pinned by the body-measurement cases (SPEC §3.3):
 *   - NUL past git's binary-sniff window: tier-2 strips the NUL at the
 *     hook's line read and the JOINED fragments over-match (refuse-match —
 *     measured 2026-09-05 against the committed chain; a truncating read
 *     would flip this to allow), while the egress reading refuses the
 *     whole body out-of-domain.
 *   - NUL inside the sniff window: tier-2 refuses on the unmeasurable
 *     (binary) outcome with no pattern ID; egress refuses out-of-domain —
 *     the corresponding content-free refusal, an agreement in effect.
 *   - Cf-split (U+200B inside the matched span): tier-2 ALLOWS — its
 *     recorded residual, #39's to close — while egress strips Cf before
 *     matching and refuses naming the pattern.
 *   - Multibyte interruption (é inside the counted class run) and a
 *     CRLF-terminated secret line: the readers AGREE (allow/clean and
 *     refuse/refuse respectively) — convergence pins, not divergences.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./run-pi.ts";

const cp = String.fromCharCode;

// ---------------------------------------------------------------------------
// Runtime-built fragments (header note: never literal in source).
// ---------------------------------------------------------------------------

/** "AKIA" — assembled from codepoints, never literal. */
export const AKIA = cp(0x41, 0x4b, 0x49, 0x41);
/** "PRIVATE KEY" — assembled from codepoints, never literal. */
const PRIVATE_KEY_WORDS = cp(0x50, 0x52, 0x49, 0x56, 0x41, 0x54, 0x45) + " " + cp(0x4b, 0x45, 0x59);
/** "ghp_" — assembled from codepoints, never literal. */
const GHP = cp(0x67, 0x68, 0x70, 0x5f);
/** "Authorization: " / "Bearer " with codepoint-built initials. */
const AUTH_HEADER = cp(0x41) + "uthorization: ";
const BEARER_WORD = cp(0x42) + "earer ";

/** U+200B ZERO WIDTH SPACE — category Cf, built from its codepoint. */
export const ZWSP = cp(0x200b);
/** U+00E9 é — one codepoint, two UTF-8 bytes, built from its codepoint. */
export const E_ACUTE = cp(0xe9);
const NUL = cp(0x00);
const CR = cp(0x0d);

// The split-secret halves: joined they are the AWS prefix + exactly 16
// class characters (a match); either half alone is too short to match, so
// a truncating reader flips the joined disposition to allow.
const AWS_SPLIT_HEAD = AKIA + "ZQ0CASES";
const AWS_SPLIT_TAIL = "ZQ4CASES";
/** The joined spelling a Cf/NUL strip produces — 16 class chars after the prefix. */
export const AWS_JOINED = AWS_SPLIT_HEAD + AWS_SPLIT_TAIL;

// ---------------------------------------------------------------------------
// The committed rule source, parsed on the file's own format contract.
// ---------------------------------------------------------------------------

/** The one committed pattern file both readers resolve (SPEC §3.3). */
export const COMMITTED_PATTERNS_PATH = join(repoRoot(), ".githooks", "helpers", "secret-patterns");

export interface CommittedPatternRow {
	id: string;
	ere: string;
}

/**
 * Parse the committed file exactly as its header states: id<TAB>ERE rows,
 * blank and `#`-leading lines ignored, a trailing CR stripped per row.
 */
export function committedPatternRows(): CommittedPatternRow[] {
	const rows: CommittedPatternRow[] = [];
	for (const rawLine of readFileSync(COMMITTED_PATTERNS_PATH, "utf8").split("\n")) {
		const line = rawLine.endsWith(CR) ? rawLine.slice(0, -1) : rawLine;
		if (/^[ \t]*$/.test(line) || line.startsWith("#")) {
			continue;
		}
		const tab = line.indexOf("\t");
		rows.push({
			id: tab === -1 ? line : line.slice(0, tab),
			ere: tab === -1 ? "" : line.slice(tab + 1),
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Per-pattern conformance cases, keyed by committed pattern ID.
// ---------------------------------------------------------------------------

export interface ConformanceCase {
	/** The committed pattern ID this case exercises (ID-closure-checked). */
	id: string;
	/** A sample the committed ERE must match (oracle-verified both ways). */
	match: string;
	/** A near-miss NO committed ERE may match (precision, both directions). */
	nearMiss: string;
}

export const CONFORMANCE_CASES: ConformanceCase[] = [
	{
		id: "private-key",
		match: "-----BEGIN RSA " + PRIVATE_KEY_WORDS + "-----",
		// Four trailing hyphens where the pattern demands five.
		nearMiss: "-----BEGIN RSA " + PRIVATE_KEY_WORDS + "----",
	},
	{
		id: "aws-access-key-id",
		match: AWS_JOINED, // prefix + 16 × [A-Z0-9]
		nearMiss: AKIA + "ZQ0CASESZQ4CASE", // prefix + only 15 class chars
	},
	{
		id: "github-token",
		match: GHP + "zqCASEzqCASEzqCASEzqCASEzqCASEzqCAS9", // prefix + 36 chars
		nearMiss: GHP + "zqCASEzqCASEzqCASEzqCASEzqCASEzqCAS", // prefix + 35 chars
	},
	{
		id: "bearer-token",
		match: AUTH_HEADER + BEARER_WORD + "zqtokenCASEzqtokenC0", // 20-char token
		nearMiss: AUTH_HEADER + BEARER_WORD + "zqtokenCASEzqtoken0", // 19-char token
	},
];

// ---------------------------------------------------------------------------
// Body-measurement cases with per-reader expected dispositions.
// ---------------------------------------------------------------------------

export type Tier2Disposition = "refuse-match" | "refuse-unmeasurable" | "allow";
export type EgressDisposition = "refuse-match" | "refuse-out-of-domain" | "clean";

export interface ReaderExpectation<D> {
	disposition: D;
	/** Required exactly when the disposition is `refuse-match`. */
	patternId?: string;
	/** Why this reader lands here — the SPEC clause, one line. */
	ground: string;
}

export interface BodyMeasurementCase {
	name: string;
	/** The body handed to each reader (staged as UTF-8 bytes for tier 2). */
	body: string;
	/**
	 * Whether the two readers deliberately diverge on this body (§3.3):
	 * their dispositions fail to CORRESPOND under the map
	 * allow↔clean, refuse-match↔refuse-match (same pattern ID),
	 * refuse-unmeasurable↔refuse-out-of-domain.
	 */
	divergent: boolean;
	tier2: ReaderExpectation<Tier2Disposition>;
	egress: ReaderExpectation<EgressDisposition>;
}

// Padding that pushes a NUL past git's content-sniff window, so the staged
// file reads as text and the hook's line read — not the binary outcome —
// decides (SPEC §3.3's staged-scan NUL clause).
const SNIFF_WINDOW_PAD = "zqpadline zqpadline zqpadline zqpadline\n".repeat(210);

export const BODY_MEASUREMENT_CASES: BodyMeasurementCase[] = [
	{
		name: "nul-join",
		body: SNIFF_WINDOW_PAD + AWS_SPLIT_HEAD + NUL + AWS_SPLIT_TAIL + "\n",
		divergent: true,
		tier2: {
			disposition: "refuse-match",
			patternId: "aws-access-key-id",
			ground:
				"a NUL past the sniff window is stripped at the hook's line read; the joined fragments " +
				"over-match (§3.3 — the error direction that can only join, never pass; a truncation would flip this to allow)",
		},
		egress: {
			disposition: "refuse-out-of-domain",
			ground: "a NUL-bearing body is out-of-domain for the egress pipeline's line-and-pattern reading (§3.3 step 1)",
		},
	},
	{
		name: "nul-binary",
		body: AWS_SPLIT_HEAD + NUL + AWS_SPLIT_TAIL + "\n",
		divergent: false,
		tier2: {
			disposition: "refuse-unmeasurable",
			ground: "a NUL inside git's sniff window marks the staged path binary — the unmeasurable-input outcome, no pattern ID (§3.3)",
		},
		egress: {
			disposition: "refuse-out-of-domain",
			ground: "the same NUL refuses out-of-domain — one refusal for every NUL position, stricter by face (§3.3 step 1)",
		},
	},
	{
		name: "cf-split",
		body: AWS_SPLIT_HEAD + ZWSP + AWS_SPLIT_TAIL + "\n",
		divergent: true,
		tier2: {
			disposition: "allow",
			ground: "the tier-2 byte matcher passes a Cf-split span intact — its recorded residual, #39's to close (§3.3)",
		},
		egress: {
			disposition: "refuse-match",
			patternId: "aws-access-key-id",
			ground: "format characters strip before matching, so the joined span matches (§3.3 step 2 — the over-match closure)",
		},
	},
	{
		name: "multibyte-interrupt",
		body: AWS_SPLIT_HEAD + E_ACUTE + AWS_SPLIT_TAIL + "\n",
		divergent: false,
		tier2: {
			disposition: "allow",
			ground: "é is outside the counted class in every committed pattern under LC_ALL=C byte semantics (§3.3)",
		},
		egress: {
			disposition: "clean",
			ground: "the byte-domain reading agrees — a multibyte interruption breaks the span for both readers (§3.3 step 3 convergence)",
		},
	},
	{
		name: "crlf-line",
		body: AWS_JOINED + CR + "\n",
		divergent: false,
		tier2: {
			disposition: "refuse-match",
			patternId: "aws-access-key-id",
			ground: "the 16-char span completes before the CR; the CR never duds the match (§3.3 — measured 2026-09-05)",
		},
		egress: {
			disposition: "refuse-match",
			patternId: "aws-access-key-id",
			ground: "per-line matching over a CRLF body still sees the intact span — convergence, not divergence (§3.3)",
		},
	},
];
