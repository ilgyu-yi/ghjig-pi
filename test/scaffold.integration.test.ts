/**
 * Integration suite for the tier-1 runtime scaffold (issue #32 ACs).
 *
 * Drives real `pi` sessions through the hermetic harness against the ghjig
 * extension loaded from THIS repository's tree (fixture symlinks
 * `.pi/extensions/ghjig.ts` + `.pi/extensions/ghjig/`). Pinned runtime
 * surface:
 *
 *   - audit records (one JSON object per line in `<seam>/audit.jsonl`)
 *     with `action` markers ordered `ext-load` → `session-start`, plus a
 *     `seam-active` announcement when the test seam is active (§4.6, §5.5);
 *   - a post-session_start session entry `customType: "ghjig-registration"`
 *     with `data: { repoRoot, stateRoot, seamActive }` (§5.9; spike:
 *     appendEntry is an action method, legal only after session_start);
 *   - no action method at extension load, checked against the D1-calibrated
 *     failure class (§3.2; §3.9 refuse-not-approve);
 *   - D2 tree isolation: `git status --porcelain` identical before/after,
 *     and the operational state root `<repo>/.ghjig/state/` absent on both
 *     sides (§5.5 — the seam, never the operational sink). The assertion
 *     targets `.ghjig/state/` rather than all of `.ghjig/` because `.ghjig/`
 *     legitimately holds per-clone untracked binding state in a working
 *     clone (§4.1); the runtime's own sink is what must stay untouched.
 *   - polluted-ambient re-run: byte-identical resolution and zero writes
 *     into a decoy tree (§4.6).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	gitPorcelain,
	isLoadTimeActionFailure,
	listTreeEntries,
	type PiRunResult,
	readAuditLines,
	readSessionEntries,
	removeFixture,
	repoRoot,
	runPi,
	type ScriptTurn,
} from "./harness/run-pi.ts";

const OPERATIONAL_STATE_ROOT = join(repoRoot(), ".ghjig", "state");
const DECOY_VARS = ["GHJIG_ROOT", "GHJIG_STATE_ROOT", "GHJIG_PI_ROOT", "PI_STATE_ROOT"] as const;

const SCRIPT: ScriptTurn[] = [
	{ kind: "toolCall", name: "bash", arguments: { command: "echo GHJIG_IT_TOOL_RAN" } },
	{ kind: "text", text: "GHJIG_IT_DONE" },
];

const VIOLATING_ENTRY = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function violating(pi: ExtensionAPI) {
	pi.appendEntry("d1-load-time-violation", { at: Date.now() });
}
`;

interface RegistrationEntry {
	customType: string;
	data: { repoRoot: string; stateRoot: string; seamActive: boolean };
}

function registrationEntries(fixture: Fixture): RegistrationEntry[] {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === "ghjig-registration",
	) as unknown as RegistrationEntry[];
}

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

function requireAudit(fixture: Fixture, result: PiRunResult): string[] {
	assert.ok(
		existsSync(fixture.auditFile),
		`no audit file at ${fixture.auditFile} — the ghjig extension left no load evidence\n${diagnostics(result)}`,
	);
	return readAuditLines(fixture);
}

let porcelainBefore: string;
let operationalRootExistedBefore: boolean;
let cleanFixture: Fixture;
let cleanRun: PiRunResult;
let d1Fixture: Fixture;
let d1Run: PiRunResult;
let pollutedFixture: Fixture;
let pollutedRun: PiRunResult;
let seamDecoyFixture: Fixture;
let seamDecoyRun: PiRunResult;
let decoyTree: string;
let decoyEntriesBefore: string[];

before(async () => {
	// D2 snapshot — taken before any run.
	porcelainBefore = gitPorcelain();
	operationalRootExistedBefore = existsSync(OPERATIONAL_STATE_ROOT);

	// Run 1: clean scripted session against the repo-tree runtime.
	cleanFixture = buildFixture({ script: SCRIPT, linkGhjigRuntime: true });
	cleanRun = await runPi(cleanFixture);

	// Run 2: D1 negative control — per-suite detector calibration.
	d1Fixture = buildFixture({
		script: [{ kind: "text", text: "D1_SHOULD_NOT_BE_REACHED" }],
		extensionFiles: { "violating.ts": VIOLATING_ENTRY },
	});
	d1Run = await runPi(d1Fixture);

	// Run 3: same scripted session, polluted ambient environment.
	decoyTree = mkdtempSync(join(tmpdir(), "ghjig-decoy-"));
	mkdirSync(join(decoyTree, ".pi", "extensions"), { recursive: true });
	mkdirSync(join(decoyTree, ".ghjig", "state"), { recursive: true });
	writeFileSync(join(decoyTree, ".pi", "extensions", "look-alike.ts"), "// decoy\n");
	decoyEntriesBefore = listTreeEntries(decoyTree);
	pollutedFixture = buildFixture({ script: SCRIPT, linkGhjigRuntime: true });
	const decoyEnv: Record<string, string> = {};
	for (const name of DECOY_VARS) {
		decoyEnv[name] = decoyTree;
	}
	pollutedRun = await runPi(pollutedFixture, { env: decoyEnv });

	// Run 4: the generic env channel tries to replace the state seam with an
	// unusable value. The seam is bound after the spread, so the attempt must
	// not reach it — `seamOverride` is the only door (§4.6).
	seamDecoyFixture = buildFixture({ script: SCRIPT, linkGhjigRuntime: true });
	seamDecoyRun = await runPi(seamDecoyFixture, {
		env: { GHJIG_TEST_STATE_ROOT: "relative/state-root" },
	});
});

after(() => {
	removeFixture(cleanFixture);
	removeFixture(d1Fixture);
	removeFixture(pollutedFixture);
	removeFixture(seamDecoyFixture);
	rmSync(decoyTree, { recursive: true, force: true });
});

describe("AC1: extension loads from the repository tree and registers at session start", () => {
	it("the hermetic run completes (exit 0, no timeout)", () => {
		assert.equal(cleanRun.exitCode, 0, diagnostics(cleanRun));
	});

	it("leaves load evidence: audit marker ordering ext-load → session-start", () => {
		const actions = requireAudit(cleanFixture, cleanRun).map(
			(line) => (JSON.parse(line) as { action: string }).action,
		);
		const loadIndex = actions.indexOf("ext-load");
		const startIndex = actions.indexOf("session-start");
		assert.ok(
			loadIndex !== -1 && startIndex !== -1 && loadIndex < startIndex,
			`expected ext-load before session-start, got actions: ${JSON.stringify(actions)}\n${diagnostics(cleanRun)}`,
		);
	});

	it("appends the registration entry to the session JSONL after session_start", () => {
		const entries = registrationEntries(cleanFixture);
		assert.equal(
			entries.length,
			1,
			`expected exactly one ghjig-registration session entry\n${diagnostics(cleanRun)}`,
		);
	});

	it("runs no action method at extension load (D1-calibrated check)", () => {
		assert.equal(isLoadTimeActionFailure(cleanRun), false, diagnostics(cleanRun));
	});

	it("D1 calibration: the detector still measures the failure class on this substrate", () => {
		assert.ok(
			isLoadTimeActionFailure(d1Run),
			`detector cannot measure: the violating probe did not produce the load-time failure class\n${diagnostics(d1Run)}`,
		);
	});
});

describe("AC2/AC4: seam-scoped state with self-announcing override (§5.5, §4.6)", () => {
	it("resolves the state root to the fixture's disposable seam target", () => {
		const [entry] = registrationEntries(cleanFixture);
		assert.equal(entry?.data.stateRoot, cleanFixture.stateDir, diagnostics(cleanRun));
	});

	it("announces the active seam in the audit file", () => {
		const actions = requireAudit(cleanFixture, cleanRun).map(
			(line) => (JSON.parse(line) as { action: string }).action,
		);
		assert.ok(actions.includes("seam-active"), `actions: ${JSON.stringify(actions)}`);
	});

	it("announces the active seam in the session entry", () => {
		const [entry] = registrationEntries(cleanFixture);
		assert.equal(entry?.data.seamActive, true, diagnostics(cleanRun));
	});

	it("self-locates the repository root from the installed tree", () => {
		const [entry] = registrationEntries(cleanFixture);
		assert.equal(entry?.data.repoRoot, repoRoot(), diagnostics(cleanRun));
	});
});

describe("AC3: audit record encoding, demonstrated on the live run (§5.5)", () => {
	it("emits every audit line as a standalone JSON object", () => {
		for (const line of requireAudit(cleanFixture, cleanRun)) {
			const parsed: unknown = JSON.parse(line);
			assert.equal(typeof parsed, "object", `unparseable audit line: ${line}`);
		}
	});

	it("encodes free text so no record spans lines (fields present on every record)", () => {
		for (const line of requireAudit(cleanFixture, cleanRun)) {
			const record = JSON.parse(line) as Record<string, unknown>;
			assert.ok(
				typeof record.timestamp === "string" &&
					typeof record.category === "string" &&
					typeof record.action === "string" &&
					typeof record.text === "string",
				`incomplete audit record: ${line}`,
			);
		}
	});
});

describe("AC4: polluted ambient environment (§4.6)", () => {
	it("the polluted run completes (exit 0, no timeout)", () => {
		assert.equal(pollutedRun.exitCode, 0, diagnostics(pollutedRun));
	});

	it("resolves the repository root byte-identically to the clean run", () => {
		const [clean] = registrationEntries(cleanFixture);
		const [polluted] = registrationEntries(pollutedFixture);
		// Guard against a vacuous undefined === undefined pass: both runs must
		// have produced a resolution before identity can be asserted.
		assert.ok(
			clean !== undefined &&
				polluted !== undefined &&
				typeof clean.data.repoRoot === "string" &&
				clean.data.repoRoot !== "" &&
				polluted.data.repoRoot === clean.data.repoRoot,
			`expected both runs to resolve the same non-empty repo root; clean=${JSON.stringify(clean?.data)} polluted=${JSON.stringify(polluted?.data)}\n${diagnostics(pollutedRun)}`,
		);
	});

	it("keeps writes under its own seam root", () => {
		assert.ok(
			existsSync(pollutedFixture.auditFile),
			`no audit file under the polluted run's seam root\n${diagnostics(pollutedRun)}`,
		);
	});

	it("adds zero entries to the decoy tree", () => {
		assert.deepEqual(listTreeEntries(decoyTree), decoyEntriesBefore);
	});
});

describe("AC4: the harness seam has exactly one door (§4.6)", () => {
	it("completes despite an env-channel attempt to replace the state seam", () => {
		assert.equal(seamDecoyRun.exitCode, 0, diagnostics(seamDecoyRun));
	});

	it("keeps the state root at the fixture's own seam target", () => {
		const [entry] = registrationEntries(seamDecoyFixture);
		assert.equal(entry?.data.stateRoot, seamDecoyFixture.stateDir, diagnostics(seamDecoyRun));
	});
});

describe("AC2/D2: repository-tree isolation snapshot", () => {
	it("leaves the operational state root absent (never created by test runs)", () => {
		assert.equal(operationalRootExistedBefore, false, `${OPERATIONAL_STATE_ROOT} existed before the suite ran`);
		assert.equal(existsSync(OPERATIONAL_STATE_ROOT), false, `${OPERATIONAL_STATE_ROOT} was created by the suite`);
	});

	it("leaves git status --porcelain byte-identical to the pre-suite snapshot", () => {
		assert.equal(gitPorcelain(), porcelainBefore);
	});
});
