/**
 * Integration suite for the session-start bind advisory of a tier that
 * derives its own locations (issue #68's amended AC5; SPEC §5.2's advisory
 * state set and §5.9's read-only detector rule).
 *
 * The state set measured here is read from the DOC, not from the
 * classifier's current tokens, because the classifier is what this change
 * moves. The three sentences it implements:
 *
 *   - "a clone whose effective hooks path does not resolve to this
 *     repository's committed adapters surfaces one such line, naming the
 *     state and the exact re-arm command" — including a hooks path this
 *     repository's instrument did not configure, "classified degraded
 *     rather than argued with";
 *   - a clone whose effective hooks path DOES resolve to them surfaces
 *     none;
 *   - "A helper set the adapters cannot resolve is not a session-start
 *     state at all: it surfaces where it degrades, at the enforcement
 *     surface."
 *
 * Drives real `pi` sessions through the hermetic harness (seam-rooted
 * state, §5.5) against the ghjig runtime linked from THIS repository's
 * tree. Each fixture root is made a git repository carrying a copy of the
 * committed `.githooks/` tree and shaped into one binding state; the suite
 * then reads the session JSONL for the advisory entry type the runtime
 * exports.
 *
 * ANTI-VACUITY. Two of the three arms assert SILENCE, which a session where
 * the extension never loaded satisfies by itself — so every arm opens with
 * `requireRuntimeLoaded`, which demands this fixture's session carry the
 * extension's own registration entry.
 *
 * POSIX substrate only: the suite skips on win32.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	BIND_ADVISORY_ENTRY_TYPE,
	BIND_REARM_COMMAND,
} from "../.pi/extensions/ghjig/bind-state.ts";
import {
	buildFixture,
	type Fixture,
	type PiRunResult,
	readSessionEntries,
	removeFixture,
	repoRoot,
	runPi,
	type ScriptTurn,
} from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";

/** The retired per-clone binding path — a file no surface reads. */
const RETIRED_BINDING_REL = join(".ghjig", "shell-adapter.sh");

const SCRIPT: ScriptTurn[] = [
	{ kind: "toolCall", name: "bash", arguments: { command: "echo GHJIG_DERIVED_IT_RAN" } },
	{ kind: "text", text: "GHJIG_DERIVED_IT_DONE" },
];

function envFor(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
	};
}

/** Run one setup git command that must succeed (substrate, never a measurement). */
function runGit(root: string, home: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd: root, env: envFor(home), timeout: 30_000 });
	if (result.status !== 0) {
		throw new Error(`substrate: git ${args.join(" ")} exited ${result.status}: ${result.stderr?.toString("utf8")}`);
	}
}

/** Make the fixture root a git repository carrying the committed `.githooks/` copy. */
function armGitRepo(fixture: Fixture): void {
	runGit(fixture.root, fixture.homeDir, ["-c", "init.defaultBranch=zqdrvmain", "init", "-q"]);
	runGit(fixture.root, fixture.homeDir, ["config", "user.name", "fixture"]);
	runGit(fixture.root, fixture.homeDir, ["config", "user.email", "fixture@invalid"]);
	runGit(fixture.root, fixture.homeDir, ["config", "commit.gpgsign", "false"]);
	cpSync(join(repoRoot(), ".githooks"), join(fixture.root, ".githooks"), { recursive: true });
}

function advisoryEntries(fixture: Fixture): Array<Record<string, unknown>> {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === BIND_ADVISORY_ENTRY_TYPE,
	);
}

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

function requireRuntimeLoaded(fixture: Fixture, run: PiRunResult, arm: string): void {
	const registrations = readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === "ghjig-registration",
	);
	assert.ok(
		registrations.length >= 1,
		`${arm}: no ghjig-registration entry — the runtime never loaded, so every advisory or silence claim ` +
			`here is vacuous\n${diagnostics(run)}`,
	);
}

let armedFixture: Fixture;
let armedRun: PiRunResult;
let foreignFixture: Fixture;
let foreignRun: PiRunResult;
let helpersGoneFixture: Fixture;
let helpersGoneRun: PiRunResult;

before(async () => {
	// 1) Armed: the effective hooks path resolves to the committed adapters,
	// and NOTHING sits at the retired binding path. This is what a bound
	// clone of this repository is: the tier derives its own locations, so a
	// per-clone binding file is no part of its bound state.
	armedFixture = buildFixture({ script: SCRIPT, linkGhjigRuntime: true });
	armGitRepo(armedFixture);
	runGit(armedFixture.root, armedFixture.homeDir, ["config", "core.hooksPath", ".githooks"]);
	armedRun = await runPi(armedFixture);

	// 2) Foreign: the effective hooks path names a directory that is not this
	// repository's committed adapters. A marker-less file sits at the retired
	// binding path, so nothing about this fixture can be satisfied by reading
	// that file rather than the configuration.
	foreignFixture = buildFixture({ script: SCRIPT, linkGhjigRuntime: true });
	armGitRepo(foreignFixture);
	mkdirSync(join(foreignFixture.root, "zqforeignhooks"));
	mkdirSync(join(foreignFixture.root, ".ghjig"));
	writeFileSync(join(foreignFixture.root, RETIRED_BINDING_REL), "# zqforeign file at the retired path\n");
	runGit(foreignFixture.root, foreignFixture.homeDir, [
		"config",
		"core.hooksPath",
		join(foreignFixture.root, "zqforeignhooks"),
	]);
	foreignRun = await runPi(foreignFixture);

	// 3) Armed, with the committed helper directory removed: a helper set the
	// adapters cannot resolve degrades at the enforcement surface, on each
	// folded arm, and is not a session-start state.
	helpersGoneFixture = buildFixture({ script: SCRIPT, linkGhjigRuntime: true });
	armGitRepo(helpersGoneFixture);
	runGit(helpersGoneFixture.root, helpersGoneFixture.homeDir, ["config", "core.hooksPath", ".githooks"]);
	rmSync(join(helpersGoneFixture.root, ".githooks", "helpers"), { recursive: true, force: true });
	helpersGoneRun = await runPi(helpersGoneFixture);
});

after(() => {
	for (const fixture of [armedFixture, foreignFixture, helpersGoneFixture]) {
		if (fixture) {
			removeFixture(fixture);
		}
	}
});

describe("a clone whose effective hooks path resolves to the committed adapters is silent (issue #68 AC5, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	it("an activated clone carrying no per-clone binding file surfaces no advisory", () => {
		requireRuntimeLoaded(armedFixture, armedRun, "armed clone");
		assert.deepEqual(
			advisoryEntries(armedFixture),
			[],
			`armed clone: a session-start advisory names a clone whose committed hooks are exactly what git ` +
				`resolves as degraded — the tier's runtime and delegated checks are that clone's own committed ` +
				`code, so a per-clone binding file is not part of its bound state (§5.2)\n${diagnostics(armedRun)}`,
		);
	});
});

describe("a hooks path that is not the committed adapters is classified degraded (issue #68 AC5, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	it("a clone whose effective hooks path names another directory surfaces exactly one advisory", () => {
		requireRuntimeLoaded(foreignFixture, foreignRun, "foreign hooks path");
		assert.equal(
			advisoryEntries(foreignFixture).length,
			1,
			`foreign hooks path: this repository's hooks do not fire under a hooks path it did not configure, ` +
				`whoever chose it, and the state is classified degraded rather than argued with (§5.2); ` +
				`got ${JSON.stringify(advisoryEntries(foreignFixture))}\n${diagnostics(foreignRun)}`,
		);
	});

	it("that advisory names the exact re-arm command", () => {
		requireRuntimeLoaded(foreignFixture, foreignRun, "foreign hooks path wording");
		const entries = advisoryEntries(foreignFixture);
		assert.equal(entries.length, 1, "foreign hooks path: no single advisory to read the wording from");
		assert.equal(
			JSON.stringify(entries[0]).includes(BIND_REARM_COMMAND),
			true,
			`foreign hooks path: the advisory does not carry the exact re-arm command "${BIND_REARM_COMMAND}" — ` +
				`a degraded state is surfaced with the act that discharges it (§5.2): ${JSON.stringify(entries[0])}`,
		);
	});
});

describe("an unresolvable helper set is not a session-start state (issue #68 AC5, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	it("an activated clone whose committed helper directory is absent surfaces no advisory", () => {
		requireRuntimeLoaded(helpersGoneFixture, helpersGoneRun, "absent helper set");
		assert.deepEqual(
			advisoryEntries(helpersGoneFixture),
			[],
			`absent helper set: a helper set the adapters cannot resolve surfaces where it degrades — at the ` +
				`enforcement surface, on each folded arm — and a session-start line for it describes a state ` +
				`the session cannot act on differently from a bound one (§5.2)\n${diagnostics(helpersGoneRun)}`,
		);
	});
});
