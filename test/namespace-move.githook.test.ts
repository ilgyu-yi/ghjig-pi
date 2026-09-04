/**
 * Behavioral arm for the local tier across the namespace move (issue #75).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/pre-commit` + `.githooks/_lib.sh` + `.githooks/helpers/` —
 * copied byte-for-byte into a disposable clone by `harness/githook-fixture.ts`
 * and driven only through `git commit`, exactly as `secret-scan.githook.test.ts`
 * drives it. Nothing here calls a predicate directly.
 *
 * THE QUESTION. The rename moves the shell's per-clone untracked state
 * namespace (SPEC §2.5's two-namespace rule; §3.2's derived sink). A clone
 * armed BEFORE that move keeps whatever `core.hooksPath` arming wrote — it
 * is a per-clone config value, not committed bytes, so the move cannot
 * rewrite it and no operator is going to re-run the bind instrument in every
 * existing clone. The tier must therefore cross the move without a re-arm:
 * still enforcing, recording into the NEW sink, with the stored binding
 * untouched. This suite is that one arm.
 *
 * Three things are asserted about one measured commit, in this order:
 *
 *   1. ENFORCEMENT SURVIVED — the staged secret is still refused. If the
 *      move made the tier inert, this fails first and the other two
 *      assertions would be measuring a chain that decided nothing. Keyed on
 *      the refusal's own observables (non-zero status + the adapter's live
 *      recovery line + the pattern ID on stderr), never on the record sink,
 *      because the sink is what the next assertion is ABOUT.
 *   2. THE SINK MOVED WITH THE NAMESPACE — the refusal record lands at
 *      `<top>/.gitjig/state/audit.jsonl`. This is the red-first half: the
 *      committed `_lib.sh` still derives the OLD container today, so the
 *      asserted file does not exist and this assertion is the suite's
 *      intentional failure.
 *   3. NO RE-ARM WAS REQUIRED — the clone's stored `core.hooksPath` is
 *      byte-identical to what arming set, before and after the measured
 *      commit. A tier that survives the move by silently rewriting the
 *      operator's config has not survived it; neither has one that needs
 *      the instrument re-run.
 *
 * WHY THE SINK PATH IS SPELLED HERE AND NOT READ FROM THE HARNESS.
 * `buildGithookFixture` exposes a `auditFile` field, and that field tracks
 * whichever container the tree currently uses. Asserting through it would
 * make this arm agree with the implementation by construction — it would be
 * green today AND after, measuring nothing. The contract path is written out
 * literally instead, from SPEC §2.5, so the assertion can disagree with the
 * tree. Only the file NAME is imported, from the harness constant.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. It measures one adapter (pre-commit)
 * on one refusal class (staged secret). It does not establish that the push
 * or commit-msg adapters moved their sink, that the tier-1 extension moved
 * its state root, or that the OLD container is no longer written — that last
 * one is the closure check's job (`name-retirement.structure.test.ts`), not
 * a behavioural arm's.
 *
 * Environment constraints, following the sibling suite: the planted secret
 * is BUILT AT RUNTIME from codepoint constants and never written literally
 * (a literal secret-shaped string here would trip the development shell's
 * own staged-secret matcher when this file is committed, and then this
 * repository's armed hook). POSIX substrate only: skips on win32.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildGithookFixture, fixtureGit, type GithookFixture, commitWithMessage, removeGithookFixture } from "./harness/githook-fixture.ts";
import { AUDIT_FILE_NAME } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";

const cp = String.fromCharCode;

/** The derived protected identity — distinctive on purpose (sibling-suite note). */
const PROTECTED = "zqmovetrunkzq";
/** The ordinary working branch: the branch arm must not decide this commit. */
const FEATURE = "zqmovefeaturezq";

/** "AKIA" — assembled from codepoints, never literal. */
const AKIA = cp(0x41, 0x4b, 0x49, 0x41);
/** A committed-pattern match: the AKIA prefix + 16 × [A-Z0-9]. */
const AWS_SECRET = AKIA + "ZQ0MOVEDZQ4MOVED";
/** The committed pattern ID this planted secret must be reported under. */
const PATTERN_ID = "aws-access-key-id";
const STAGED_PATH = "zqmoveleak.txt";

/**
 * The state namespace the contract names (SPEC §2.5), written literally
 * rather than read from the harness — see the header's note on why.
 */
const STATE_CONTAINER = ".gitjig";

/** The sink the tier must derive from a clone's repository top after the move. */
function contractSink(fixture: GithookFixture): string {
	return join(fixture.root, STATE_CONTAINER, "state", AUDIT_FILE_NAME);
}

/**
 * The clone's OWN stored `core.hooksPath`, as raw bytes. `-z` terminates the
 * value with NUL rather than LF, so the comparison is over the stored bytes
 * and not over a line-ending rendering.
 */
function storedHooksPath(fixture: GithookFixture): Buffer {
	const result = spawnSync("git", ["config", "-z", "--local", "--get", "core.hooksPath"], {
		cwd: fixture.root,
		env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1" },
	});
	assert.equal(result.status, 0, "the fixture clone carries no local core.hooksPath — it was never armed");
	const out = result.stdout ?? Buffer.alloc(0);
	const nul = out.indexOf(0);
	return nul === -1 ? out : out.subarray(0, nul);
}

describe("a clone armed before the namespace move needs no re-arm (issue #75, SPEC §2.5, §3.2)", { skip: IS_WINDOWS }, () => {
	it("still refuses a staged secret, records under the moved sink, and leaves the stored binding untouched", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);

			// Arming already happened at build (`core.hooksPath` = the committed
			// adapters). Capture what it wrote, and verify it genuinely points
			// at the adapters — a captured-then-compared value would agree with
			// itself even if arming had pointed nowhere.
			const armed = storedHooksPath(fixture);
			assert.notEqual(armed.length, 0, "arming stored an empty core.hooksPath — nothing was bound");
			assert.equal(
				existsSync(join(fixture.root, armed.toString("utf8"), "pre-commit")),
				true,
				`the stored core.hooksPath ${JSON.stringify(armed.toString("utf8"))} does not resolve to the ` +
					`committed pre-commit adapter — this clone is not armed, so nothing below measures the tier`,
			);

			writeFileSync(join(fixture.root, STAGED_PATH), AWS_SECRET + "\n");
			fixtureGit(fixture, ["add", "--", STAGED_PATH]);
			const attempt = commitWithMessage(fixture, "chore: exercise the namespace-move arm\n");

			// 1. Enforcement survived. Keyed on the refusal's own observables,
			//    never on the sink (the sink is assertion 2's subject).
			assert.notEqual(
				attempt.status,
				0,
				`the guarded commit SUCCEEDED — the tier went inert across the namespace move: ${attempt.stderr}`,
			);
			assert.match(
				attempt.stderr,
				/\[dev-shell\]/,
				"the refusal reached the operator without the adapter's live recovery line (§3.11)",
			);
			assert.equal(
				attempt.stderr.includes(PATTERN_ID),
				true,
				`the refusal's stderr does not name pattern '${PATTERN_ID}' — the refusal is not the staged-secret one`,
			);

			// 2. The sink moved with the namespace (RED TODAY: `_lib.sh` still
			//    derives the retired container, so this path does not exist).
			const sink = contractSink(fixture);
			assert.equal(
				existsSync(sink),
				true,
				`no record sink at <top>/${STATE_CONTAINER}/state/${AUDIT_FILE_NAME} — the tier refused the ` +
					`commit but wrote its record somewhere else, so an armed clone's records did not follow the ` +
					`namespace move (red until the Code phase moves the derived container; SPEC §2.5)`,
			);
			const records = readFileSync(sink, "utf8");
			assert.match(
				records,
				/\bblock\b.*\bsecret\b/,
				`the moved sink carries no block record naming the secret class; sink contents: ${JSON.stringify(records)}`,
			);
			assert.equal(
				records.includes(PATTERN_ID),
				true,
				`the moved sink's record does not name pattern '${PATTERN_ID}' (§3.3 pattern-ID reporting)`,
			);

			// 3. No re-arm was required, and nothing rewrote the binding.
			assert.equal(
				storedHooksPath(fixture).equals(armed),
				true,
				`the clone's stored core.hooksPath changed across the measured commit — an armed clone's own ` +
					`config is the operator's, not the tier's to rewrite (was ${JSON.stringify(armed.toString("utf8"))}, ` +
					`now ${JSON.stringify(storedHooksPath(fixture).toString("utf8"))})`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
