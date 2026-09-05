/**
 * Convergence-lock suite for the two readers of the one committed pattern
 * file (issue #83 AC4; SPEC §3.3's egress rule-source clause, §3.11's
 * converged-implementations clause). The lock is the shared case set
 * `test/harness/secret-pattern-cases.ts`; this suite runs BOTH readers
 * against it:
 *
 *   - the tier-2 reader through the committed chain — a githook fixture
 *     driven by `git commit`, never a predicate called directly;
 *   - the egress reader through the (Phase-C) module
 *     `.pi/extensions/gitjig/publish/scan.ts` — RED until that module
 *     lands: every egress-reader arm first requires the module and fails
 *     with its authored message while it is absent, so the red is the
 *     subject's absence and never a harness crash that kills siblings.
 *
 * AUTHORED PHASE-C CONTRACT (what the egress-reader arms bind to): the
 * module exports `scanBody(body: string)` returning one of
 *   { disposition: "clean" }
 *   { disposition: "refuse-out-of-domain" }
 *   { disposition: "refuse-match", patternIds: string[] }  // committed IDs
 * per §3.3's ordered pipeline (NUL → out-of-domain; Cf stripped; per-line
 * byte-domain matching). The result NEVER carries the matched text.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. The bash-oracle arms prove that the
 * case samples and the committed EREs agree under the tier-2 engine's own
 * dialect (`[[ =~ ]]`, LC_ALL=C) — they do not prove the scanner's
 * plumbing (the githook arms do that) nor the egress reader's semantics
 * (its own arms do). ID closure is lexical set equality over the committed
 * file's rows — it proves every committed pattern HAS a case, not that any
 * reader honors it. Nothing here touches a publish surface: the egress
 * reader is exercised as a pure function, and the instrument around it is
 * `egress-publish.integration.test.ts`'s subject.
 *
 * Mutants, both directions, for every matcher surface:
 *   - a dud match sample (would silently prove nothing) dies at the oracle
 *     match arm; an over-wide near-miss dies at the oracle no-match arm;
 *   - a committed pattern row added without a case dies at ID closure (⊇),
 *     a case naming a dead ID dies at ID closure (⊆);
 *   - a truncating tier-2 NUL read (allow) dies at the nul-join arm, and
 *     an over-eager binary verdict (refusing the joined match as
 *     unmeasurable) dies at the same arm's pattern-ID assertion;
 *   - each reader is driven with matching AND non-matching inputs, so a
 *     reader that always refuses or always allows reddens both ways.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";
import {
	BODY_MEASUREMENT_CASES,
	committedPatternRows,
	CONFORMANCE_CASES,
} from "./harness/secret-pattern-cases.ts";

const IS_WINDOWS = process.platform === "win32";

/** The egress reader's Phase-C home (SPEC §3.3 egress row; issue #83). */
const SCAN_MODULE_PATH = join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "scan.ts");
const SCAN_MODULE_RED =
	"red until the Code phase lands .pi/extensions/gitjig/publish/scan.ts exporting scanBody " +
	"(issue #83 AC4 — the egress consumer is the committed pattern file's second reader, SPEC §3.3)";

type EgressScanOutcome =
	| { disposition: "clean" }
	| { disposition: "refuse-out-of-domain" }
	| { disposition: "refuse-match"; patternIds: string[] };

let scanBody: ((body: string) => EgressScanOutcome) | undefined;

before(async () => {
	// Guarded dynamic import: while the module is absent the arms below red
	// on `requireScanner`'s authored message instead of a loader crash that
	// would take the oracle and tier-2 arms down with it (header note).
	if (existsSync(SCAN_MODULE_PATH)) {
		const mod = (await import(SCAN_MODULE_PATH)) as Record<string, unknown>;
		if (typeof mod.scanBody === "function") {
			scanBody = mod.scanBody as (body: string) => EgressScanOutcome;
		}
	}
});

function requireScanner(): (body: string) => EgressScanOutcome {
	assert.ok(scanBody !== undefined, SCAN_MODULE_RED);
	return scanBody as (body: string) => EgressScanOutcome;
}

/**
 * The tier-2 engine's own dialect as oracle: one child bash per probe,
 * LC_ALL=C (§3.3's pinned matcher). Keyed by outcome (§3.10): 0 = match,
 * 1 = no match, anything else = the probe could not measure.
 */
function ereMatches(sample: string, ere: string): boolean {
	const probe = spawnSync("bash", ["-c", '[[ "$2" =~ $1 ]]; exit "$?"', "bash", ere, sample], {
		env: { PATH: process.env.PATH ?? "", LC_ALL: "C" },
	});
	assert.ok(
		probe.status === 0 || probe.status === 1,
		`ERE oracle probe failed (status ${probe.status}) for pattern ${JSON.stringify(ere)}: ` +
			`${(probe.stderr ?? Buffer.alloc(0)).toString("utf8")}`,
	);
	return probe.status === 0;
}

// ---------------------------------------------------------------------------
// Case-set integrity — green now; the lock's own mutants die here.
// ---------------------------------------------------------------------------

describe("case-set integrity: ID closure and oracle agreement (issue #83 AC4)", { skip: IS_WINDOWS }, () => {
	it("ID closure, both directions: the case set and the committed file name the same IDs", () => {
		const committedIds = committedPatternRows().map((row) => row.id);
		const caseIds = CONFORMANCE_CASES.map((c) => c.id);
		for (const id of committedIds) {
			assert.ok(
				caseIds.includes(id),
				`committed pattern '${id}' has no conformance case — a pattern can reach one reader ` +
					`untested by the lock (issue #83 AC4's failing direction)`,
			);
		}
		for (const id of caseIds) {
			assert.ok(
				committedIds.includes(id),
				`conformance case '${id}' names no committed pattern — a stale case vouches for a rule that is gone`,
			);
		}
		assert.equal(new Set(caseIds).size, caseIds.length, "duplicate case IDs would let one arm mask another");
	});

	it("every match sample matches its OWN committed ERE under the tier-2 oracle (kills a dud sample)", () => {
		const rows = committedPatternRows();
		for (const conformanceCase of CONFORMANCE_CASES) {
			const row = rows.find((r) => r.id === conformanceCase.id);
			assert.ok(row !== undefined, `no committed row for '${conformanceCase.id}' (ID closure should have caught this)`);
			assert.ok(
				ereMatches(conformanceCase.match, (row as { ere: string }).ere),
				`case '${conformanceCase.id}': the match sample does not match its committed ERE — ` +
					`every reader arm built on it would prove nothing`,
			);
		}
	});

	it("every near-miss matches NO committed ERE under the oracle (kills an over-wide sample)", () => {
		const rows = committedPatternRows();
		for (const conformanceCase of CONFORMANCE_CASES) {
			for (const row of rows) {
				assert.ok(
					!ereMatches(conformanceCase.nearMiss, row.ere),
					`case '${conformanceCase.id}': the near-miss matches committed pattern '${row.id}' — ` +
						`the allow-direction arms built on it would refuse for the wrong reason`,
				);
			}
		}
	});

	it("every refuse-match expectation names a committed pattern ID, and the declared divergences are exactly the SPEC's", () => {
		const committedIds = committedPatternRows().map((row) => row.id);
		for (const bodyCase of BODY_MEASUREMENT_CASES) {
			for (const [reader, expectation] of [
				["tier2", bodyCase.tier2],
				["egress", bodyCase.egress],
			] as const) {
				if (expectation.disposition === "refuse-match") {
					assert.ok(
						expectation.patternId !== undefined && committedIds.includes(expectation.patternId),
						`body case '${bodyCase.name}' (${reader}): refuse-match without a committed pattern ID`,
					);
				}
			}
			// Correspondence map (case-set contract): allow↔clean,
			// refuse-match↔refuse-match with the same pattern ID,
			// refuse-unmeasurable↔refuse-out-of-domain.
			const corresponds =
				bodyCase.tier2.disposition === "allow"
					? bodyCase.egress.disposition === "clean"
					: bodyCase.tier2.disposition === "refuse-match"
						? bodyCase.egress.disposition === "refuse-match" &&
							bodyCase.egress.patternId === bodyCase.tier2.patternId
						: bodyCase.egress.disposition === "refuse-out-of-domain";
			assert.equal(
				corresponds,
				!bodyCase.divergent,
				`body case '${bodyCase.name}': the divergent flag contradicts the declared dispositions — ` +
					`a reader divergence must be declared, never incidental (SPEC §3.3's enumerated divergences)`,
			);
		}
		const divergent = BODY_MEASUREMENT_CASES.filter((c) => c.divergent).map((c) => c.name).sort();
		assert.deepEqual(
			divergent,
			["cf-split", "nul-join"],
			"the divergence set drifted from §3.3's enumerated per-reader divergences (the NUL-join strip and the Cf allowance)",
		);
	});
});

// ---------------------------------------------------------------------------
// Tier-2 arm — the committed chain against every applicable case. Green
// now: the scanner and its pattern file are landed and armed (issue #66).
// ---------------------------------------------------------------------------

/** Build the standard scan fixture on a feature branch (sibling-suite idiom). */
function buildScanFixture(): GithookFixture {
	const fixture = buildGithookFixture({ remote: { defaultBranch: "zqegresstrunkzq" } });
	fixtureGit(fixture, ["checkout", "-q", "-b", "zqegressfeat"]);
	return fixture;
}

function stageAndCommit(name: string, content: Buffer): CommitAttempt {
	const fixture = buildScanFixture();
	try {
		writeFileSync(join(fixture.root, name), content);
		fixtureGit(fixture, ["add", "--", name]);
		return commitWithMessage(fixture, "chore: exercise a conformance-lock case\n");
	} finally {
		removeGithookFixture(fixture);
	}
}

describe("tier-2 arm: the committed chain honors every applicable case (issue #83 AC4)", { skip: IS_WINDOWS }, () => {
	for (const conformanceCase of CONFORMANCE_CASES) {
		it(`match sample '${conformanceCase.id}': refused naming the pattern ID`, () => {
			const attempt = stageAndCommit(`zqlock-${conformanceCase.id}.txt`, Buffer.from(conformanceCase.match + "\n", "utf8"));
			assert.notEqual(attempt.status, 0, `tier-2 '${conformanceCase.id}': the staged match COMMITTED`);
			assert.match(attempt.auditDelta, /\bblock\b.*\bsecret\b/, `tier-2 '${conformanceCase.id}': no secret block record`);
			assert.ok(
				attempt.auditDelta.includes(conformanceCase.id),
				`tier-2 '${conformanceCase.id}': the refusal record does not name the pattern ID (§3.3)`,
			);
		});

		it(`near-miss '${conformanceCase.id}': allowed with no block record`, () => {
			const attempt = stageAndCommit(`zqlock-nm-${conformanceCase.id}.txt`, Buffer.from(conformanceCase.nearMiss + "\n", "utf8"));
			assert.equal(attempt.status, 0, `tier-2 near-miss '${conformanceCase.id}': ${attempt.stderr}`);
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`tier-2 near-miss '${conformanceCase.id}': a non-matching sample was refused — an over-wide reader`,
			);
		});
	}

	for (const bodyCase of BODY_MEASUREMENT_CASES) {
		it(`body case '${bodyCase.name}': tier-2 lands ${bodyCase.tier2.disposition} — ${bodyCase.tier2.ground}`, () => {
			const attempt = stageAndCommit(`zqlock-body-${bodyCase.name}.txt`, Buffer.from(bodyCase.body, "utf8"));
			const committedIds = committedPatternRows().map((row) => row.id);
			switch (bodyCase.tier2.disposition) {
				case "refuse-match": {
					assert.notEqual(attempt.status, 0, `tier-2 '${bodyCase.name}': the staged body COMMITTED`);
					assert.match(attempt.auditDelta, /\bblock\b.*\bsecret\b/, `tier-2 '${bodyCase.name}': no secret block record`);
					assert.ok(
						attempt.auditDelta.includes(bodyCase.tier2.patternId as string),
						`tier-2 '${bodyCase.name}': the record does not name '${bodyCase.tier2.patternId}' — for nul-join ` +
							`this is the JOIN direction's pin: a truncating line read yields fragments too short to match`,
					);
					break;
				}
				case "refuse-unmeasurable": {
					assert.notEqual(attempt.status, 0, `tier-2 '${bodyCase.name}': the staged body COMMITTED`);
					assert.match(attempt.auditDelta, /\bblock\b.*\bsecret\b/, `tier-2 '${bodyCase.name}': no secret block record`);
					for (const id of committedIds) {
						assert.ok(
							!attempt.auditDelta.includes(id),
							`tier-2 '${bodyCase.name}': an unmeasurable-input refusal names pattern '${id}' (§3.9's split)`,
						);
					}
					break;
				}
				case "allow": {
					assert.equal(attempt.status, 0, `tier-2 '${bodyCase.name}': ${attempt.stderr}`);
					assert.doesNotMatch(
						attempt.auditDelta,
						/\bblock\b/,
						`tier-2 '${bodyCase.name}': an allow-side case was refused — for cf-split this widens ` +
							`the tier-2 reader past its recorded residual without a Doc change (§3.3)`,
					);
					break;
				}
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Egress-reader arm — RED until Phase C lands publish/scan.ts.
// ---------------------------------------------------------------------------

describe("egress-reader arm: publish/scan.ts against the same case set (issue #83 AC4)", () => {
	it("the egress reader module resolves and exports scanBody", () => {
		assert.ok(existsSync(SCAN_MODULE_PATH), SCAN_MODULE_RED);
		assert.ok(scanBody !== undefined, SCAN_MODULE_RED);
	});

	for (const conformanceCase of CONFORMANCE_CASES) {
		it(`match sample '${conformanceCase.id}': refuse-match naming the pattern ID, never the text`, () => {
			const scan = requireScanner();
			const outcome = scan(conformanceCase.match);
			assert.equal(
				outcome.disposition,
				"refuse-match",
				`egress '${conformanceCase.id}': expected refuse-match, got ${JSON.stringify(outcome)}`,
			);
			const ids = (outcome as { patternIds: string[] }).patternIds;
			assert.ok(
				Array.isArray(ids) && ids.includes(conformanceCase.id),
				`egress '${conformanceCase.id}': the outcome does not name the pattern ID (§3.3 pattern-ID reporting)`,
			);
			assert.ok(
				!JSON.stringify(outcome).includes(conformanceCase.match),
				`egress '${conformanceCase.id}': the outcome carries the matched text (§3.8's refusal-record rule)`,
			);
		});

		it(`near-miss '${conformanceCase.id}': clean`, () => {
			const scan = requireScanner();
			const outcome = scan(conformanceCase.nearMiss);
			assert.equal(
				outcome.disposition,
				"clean",
				`egress near-miss '${conformanceCase.id}': a non-matching body was refused — got ${JSON.stringify(outcome)}`,
			);
		});
	}

	for (const bodyCase of BODY_MEASUREMENT_CASES) {
		it(`body case '${bodyCase.name}': egress lands ${bodyCase.egress.disposition} — ${bodyCase.egress.ground}`, () => {
			const scan = requireScanner();
			const outcome = scan(bodyCase.body);
			assert.equal(
				outcome.disposition,
				bodyCase.egress.disposition,
				`egress '${bodyCase.name}': got ${JSON.stringify(outcome)}`,
			);
			if (bodyCase.egress.disposition === "refuse-match") {
				const ids = (outcome as { patternIds: string[] }).patternIds;
				assert.ok(
					Array.isArray(ids) && ids.includes(bodyCase.egress.patternId as string),
					`egress '${bodyCase.name}': the outcome does not name '${bodyCase.egress.patternId}'`,
				);
			}
		});
	}
});
