/**
 * Structural suite for the warning-surface escaping rule (issue #47).
 *
 * Subject under test: the text of the four shipped runtime sources,
 * `.pi/extensions/ghjig/{audit,locate,state-root,postures}.ts`.
 *
 * The rule (SPEC §3.10): "a write the guard itself permits must not be able
 * to forge the guard's decisions", and the mitigation for such a class
 * applies "uniformly, with an empty exemption set and a structural lock, so
 * a new site cannot drift in unguarded". The behavioural half of #47 is
 * pinned by `primitives.unit.test.ts`'s forged-line arms, one per emitting
 * surface that exists TODAY; this suite is the structural lock those arms
 * cannot be — a site added tomorrow gets no behavioural arm until someone
 * remembers to write one, but it cannot avoid this scan. SPEC §2.5 permits
 * exactly this shape and no more: "A contract testable only by grepping
 * prose is stranded — it moves into code both sides call. Structural checks
 * over prose files remain normal tests."
 *
 * The lock is lexical: every `${…}` interpolation in the four sources must
 * either be escaped where it stands — an expression beginning `quoted(` or
 * `JSON.stringify(` — or appear on that file's exact-text allowlist of
 * expressions that carry no path: numeric Stats dimensions, and the
 * composed-message CARRIERS (`cause`, `recovery`, `RECOVERY`, `STATE_SEAM`)
 * whose path content is escaped at its own leaf, where escaping again would
 * double-escape and mangle prose. A second arm holds the one taint the
 * `${…}` scan cannot see: a raw `error.message`/`String(error)` extraction
 * (an ENOENT message embeds the path) must be wrapped at the extraction.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only shape: a check
 * that does not establish a property says so, so a green run is never read
 * as the missing guarantee). Every assertion below is a claim about source
 * text. None is a claim about runtime behaviour — that half lives in the
 * behavioural arms. Specifically, a green run here does NOT establish:
 *
 *   1. That the sources parse as TypeScript, or that the scan sees what a
 *      parser would. There is no TS parser in this dependency-free tree
 *      (no `package.json` exists), so the readers below are narrow text
 *      scanners over a comment-stripped view. They can be fooled by shapes
 *      these files do not write: a nested template literal, an
 *      interpolation whose expression itself contains `{`…`}`, a `${` in a
 *      plain quoted string, a trailing `//` comment sharing a line with
 *      code, a `/*` inside a string.
 *   2. That `quoted(` resolves to the escaping helper. The scan verifies
 *      the SPELLING, not the callee: a local function named `quoted` that
 *      does not escape would pass. The helper's own contract is pinned
 *      behaviourally, not here.
 *   3. That an allowlisted expression is untainted. The allowlist admits
 *      exact TEXT per file, so an allowlisted spelling reused for a
 *      genuinely path-bearing variable in the same file is admitted —
 *      per-file scoping narrows that residual but does not close it.
 *   4. That message construction OUTSIDE these four files is escaped. The
 *      lock covers the modules #47 names; a fifth module emitting warnings
 *      joins the roster by being added to SOURCES, and nothing here notices
 *      its absence.
 *   5. That a raw error read wrapped LATER on the same line is really
 *      escaped: the raw-extraction arm is same-line lexical, so
 *      `quoted(x) + error.message` would be admitted.
 *
 * The scanner's own teeth are pinned by the synthetic-mutant arms at the
 * bottom (§3.12 — a guard the suite never measures is decoration): a raw
 * interpolation in an inline source must be reported, a `quoted(` one must
 * pass, and an unlisted bare identifier must be reported even beside an
 * allowlisted one — so a NEW raw site demonstrably fails this check, not
 * just the sites red at the commit that introduced it.
 *
 * This suite reads four files from disk and writes nothing: no network, no
 * `gh`, no `pi`, no fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const EXTENSION_DIR = join(repoRoot(), ".pi", "extensions", "ghjig");

/**
 * The roster and each file's exact-text allowlist of non-path expressions.
 * Every entry names why it carries no path; an expression not on the list
 * and not escaped where it stands is a violation, so the exemption set
 * stays enumerated here rather than accreting inline (§3.10).
 */
const SOURCES: readonly { file: string; allow: readonly string[] }[] = [
	{
		file: "audit.ts",
		allow: [
			// Numeric dimensions of the sink verdict's Stats — no byte of any
			// of them comes from a path component.
			"stats.nlink",
			"(stats.mode & 0o777).toString(8)",
			"stats.uid",
			"euid",
			// The verdict's enumerated dimensions: prose composed above from
			// the allowlisted pieces, joined — never a raw path.
			'failed.join("; ")',
			// warnDegraded's carriers: composed messages whose path content is
			// escaped at its own leaf; escaping the carrier double-escapes.
			"cause",
			"recovery",
		],
	},
	{ file: "locate.ts", allow: [] },
	{
		file: "state-root.ts",
		allow: [
			// The seam's NAME is a constant of this module, not a value an
			// actor supplies.
			"STATE_SEAM",
			// The empty-seam rendering: the only branch that reaches the
			// message unquoted is the string constant "empty value" — the
			// seam itself passes through quoted() — so no actor byte rides
			// this expression raw.
			'seam === "" ? "empty value" : quoted(seam)',
			// The shared recovery clause: a carrier composed of STATE_SEAM and
			// fixed prose, escaped nowhere because it carries no path.
			"RECOVERY",
		],
	},
	// No interpolation exists in postures.ts today; it is on the roster so
	// the module most likely to grow a message cannot grow a raw one.
	{ file: "postures.ts", allow: [] },
];

function read(file: string): string {
	return readFileSync(join(EXTENSION_DIR, file), "utf8");
}

/**
 * The comment-free view. The headers of all four sources NAME the tokens
 * the scans below turn on — `${`, `error.message`, `JSON.stringify` —
 * while explaining the decisions behind them, so a scan over the raw text
 * would report the commentary as the code. Block comments are removed
 * bodily; line comments only when the line carries nothing else (the
 * sources write no trailing comments — residual 1 in the header).
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n");
}

/**
 * Every `${…}` whose expression is neither escaped where it stands nor on
 * the file's allowlist. Exported to the mutant arms below by being the one
 * verdict function both the roster arms and the self-tests call — one
 * predicate, two call sites (§3.11).
 */
function interpolationViolations(source: string, allow: readonly string[]): string[] {
	const violations: string[] = [];
	for (const match of stripComments(source).matchAll(/\$\{([^}]*)\}/g)) {
		const expression = match[1].trim();
		if (expression.startsWith("quoted(") || expression.startsWith("JSON.stringify(")) {
			continue;
		}
		if (allow.includes(expression)) {
			continue;
		}
		violations.push(expression);
	}
	return violations;
}

/**
 * Lines that read `error.message` or `String(error)` with no `quoted(` or
 * `JSON.stringify(` opening before the read on the same line. This is the
 * taint the `${…}` scan cannot see: `warnDegraded(reason, …)` carries a
 * path-bearing message in argument position with no interpolation at all.
 */
function rawErrorReads(source: string): string[] {
	const offenders: string[] = [];
	for (const line of stripComments(source).split("\n")) {
		const at = line.search(/\berror\.message\b|\bString\(error\)/);
		if (at === -1) {
			continue;
		}
		if (/(quoted|JSON\.stringify)\(/.test(line.slice(0, at))) {
			continue;
		}
		offenders.push(line.trim());
	}
	return offenders;
}

describe("warning-surface escaping lock (§3.10, issue #47)", () => {
	for (const { file, allow } of SOURCES) {
		it(`every interpolated path in ${file} is escaped at the point of interpolation`, () => {
			const violations = interpolationViolations(read(file), allow);
			assert.equal(
				violations.length,
				0,
				`${file} interpolates ${violations.length} expression(s) raw — each is a surface a hostile path ` +
					`component can forge a line into or land control bytes on (issue #47). Escape each where it ` +
					`stands (quoted(…)), or, only if it provably carries no path, add its exact text to this ` +
					`file's allowlist above: ${JSON.stringify(violations, null, 2)}`,
			);
		});
	}

	it("no raw error extraction flows to a warn/throw surface in any shipped source", () => {
		const offenders: string[] = [];
		for (const { file } of SOURCES) {
			for (const line of rawErrorReads(read(file))) {
				offenders.push(`${file}: ${line}`);
			}
		}
		assert.equal(
			offenders.length,
			0,
			`a raw error.message/String(error) read reaches a message surface unescaped — a filesystem error ` +
				`message embeds the hostile path verbatim, so this carrier forges lines exactly as an ` +
				`interpolation does (issue #47). Wrap the extraction in quoted(…): ${JSON.stringify(offenders, null, 2)}`,
		);
	});
});

describe("the lock's own teeth (§3.12 — a guard the suite never measures is decoration)", () => {
	it("reports a raw interpolation in a synthetic source", () => {
		assert.deepEqual(interpolationViolations("console.warn(`at ${somePath}`);", []), ["somePath"]);
	});

	it("admits a quoted() interpolation in a synthetic source", () => {
		assert.deepEqual(interpolationViolations("console.warn(`at ${quoted(somePath)}`);", []), []);
	});

	it("reports an unlisted bare identifier even beside an allowlisted one", () => {
		assert.deepEqual(interpolationViolations("console.warn(`${cause} at ${sinkPath}`);", ["cause"]), [
			"sinkPath",
		]);
	});

	it("reports a raw error extraction and admits a wrapped one", () => {
		assert.deepEqual(rawErrorReads("const reason = error.message;"), ["const reason = error.message;"]);
		assert.deepEqual(rawErrorReads("const reason = quoted(error.message);"), []);
	});
});
