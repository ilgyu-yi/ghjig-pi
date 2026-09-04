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
 * state, §5.5) against the gitjig runtime linked from THIS repository's
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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	BIND_ADVISORY_ENTRY_TYPE,
	BIND_REARM_COMMAND,
	computeBindState,
} from "../.pi/extensions/gitjig/bind-state.ts";
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
const RETIRED_BINDING_REL = join(".gitjig", "shell-adapter.sh");

const SCRIPT: ScriptTurn[] = [
	{ kind: "toolCall", name: "bash", arguments: { command: "echo GITJIG_DERIVED_IT_RAN" } },
	{ kind: "text", text: "GITJIG_DERIVED_IT_DONE" },
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
		(entry) => entry.type === "custom" && entry.customType === "gitjig-registration",
	);
	assert.ok(
		registrations.length >= 1,
		`${arm}: no gitjig-registration entry — the runtime never loaded, so every advisory or silence claim ` +
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
	armedFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(armedFixture);
	runGit(armedFixture.root, armedFixture.homeDir, ["config", "core.hooksPath", ".githooks"]);
	armedRun = await runPi(armedFixture);

	// 2) Foreign: the effective hooks path names a directory that is not this
	// repository's committed adapters. A marker-less file sits at the retired
	// binding path, so nothing about this fixture can be satisfied by reading
	// that file rather than the configuration.
	foreignFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(foreignFixture);
	mkdirSync(join(foreignFixture.root, "zqforeignhooks"));
	mkdirSync(join(foreignFixture.root, ".gitjig"));
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
	helpersGoneFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
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

// ---------------------------------------------------------------------------
// Classifier/consumer config-resolution agreement (§4.6): the classifier's
// child resolves the same configuration the consumer's git resolves, driven
// directly against computeBindState with the consumer's environment set on
// this process. Each arm derives the consumer's answer with the consumer's
// own command under the identical environment, so the proposition measured
// is agreement, never a hardcoded expectation.
// ---------------------------------------------------------------------------

describe("the classifier resolves the configuration the consumer's git resolves (issue #68 AC5, SPEC §4.6)", { skip: IS_WINDOWS }, () => {
	/** Set env members for one call, restoring the prior state whatever happens. */
	function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
		const saved = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(overrides)) {
			saved.set(key, process.env[key]);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		try {
			run();
		} finally {
			for (const [key, value] of saved.entries()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	}

	/** A scratch repository carrying the committed .githooks, no local hooksPath. */
	function scratchRepo(home: string): string {
		const root = mkdtempSync(join(tmpdir(), "gitjig-xdg-repo-"));
		runGit(root, home, ["-c", "init.defaultBranch=zqxdgmain", "init", "-q"]);
		cpSync(join(repoRoot(), ".githooks"), join(root, ".githooks"), { recursive: true });
		return root;
	}

	/** The consumer's own resolution of core.hooksPath under this process env. */
	function consumerResolves(root: string): string {
		const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
			cwd: root,
			env: { ...process.env },
			timeout: 30_000,
		});
		return result.status === 0 ? result.stdout.toString("utf8").trim() : "";
	}

	it("a global binding the consumer's git does not read is not read by the classifier either", () => {
		const home = mkdtempSync(join(tmpdir(), "gitjig-xdg-home-"));
		const xdgElsewhere = mkdtempSync(join(tmpdir(), "gitjig-xdg-empty-"));
		const root = scratchRepo(home);
		try {
			mkdirSync(join(home, ".config", "git"), { recursive: true });
			writeFileSync(join(home, ".config", "git", "config"), `[core]\n\thooksPath = ${join(root, ".githooks")}\n`);
			withEnv({ HOME: home, XDG_CONFIG_HOME: xdgElsewhere, GIT_CONFIG_NOSYSTEM: "1" }, () => {
				assert.equal(
					consumerResolves(root),
					"",
					"substrate: the consumer's git read $HOME/.config despite XDG_CONFIG_HOME pointing elsewhere",
				);
				assert.equal(
					computeBindState(root),
					"unbound",
					"a classifier that resolves a binding the consumer's git does not read reports bound on a " +
						"clone whose committed hooks do not fire — the silent degraded state §5.2 forbids",
				);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
			rmSync(xdgElsewhere, { recursive: true, force: true });
		}
	});

	it("a binding homed under XDG_CONFIG_HOME classifies bound, not degraded", () => {
		const home = mkdtempSync(join(tmpdir(), "gitjig-xdg-home2-"));
		const xdg = mkdtempSync(join(tmpdir(), "gitjig-xdg-cfg-"));
		const root = scratchRepo(home);
		try {
			mkdirSync(join(xdg, "git"), { recursive: true });
			writeFileSync(join(xdg, "git", "config"), `[core]\n\thooksPath = ${join(root, ".githooks")}\n`);
			withEnv({ HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: "1" }, () => {
				assert.notEqual(
					consumerResolves(root),
					"",
					"substrate: the consumer's git did not resolve the XDG-homed binding",
				);
				assert.equal(
					computeBindState(root),
					"bound",
					"a clone whose consumer-resolved hooks path is the committed adapters earns no advisory — " +
						"an advisory here nags a clone whose tier fires (§5.2)",
				);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// `bound` is the SILENT state, so the classifier reaches it only where the
// adapters would actually run. The shapes measured here all pass the
// resolved-path compare and arm nothing: a hooks directory that resolves
// outside the repository, and adapter files that are absent, empty, or not
// executable by this account. Each arm derives its own positive control from
// the same fixture before mutating it, so a degraded verdict below is the
// mutation and never a dead substrate.
// ---------------------------------------------------------------------------

describe("the classifier does not report bound where the adapters would not run (issue #68 AC5, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	/** A scratch repository carrying the committed .githooks, bound at its own scope. */
	function boundRepo(): string {
		const root = mkdtempSync(join(tmpdir(), "gitjig-armverdict-"));
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		runGit(root, home, ["-c", "init.defaultBranch=zqverdictmain", "init", "-q"]);
		cpSync(join(repoRoot(), ".githooks"), join(root, ".githooks"), { recursive: true });
		runGit(root, home, ["config", "core.hooksPath", ".githooks"]);
		return root;
	}

	it("a bound clone whose adapters were removed is classified degraded", () => {
		const root = boundRepo();
		try {
			assert.equal(
				computeBindState(root),
				"bound",
				"substrate: the unmutated clone did not classify bound, so the mutation below measures nothing",
			);
			for (const adapter of ["pre-commit", "pre-push", "commit-msg"]) {
				rmSync(join(root, ".githooks", adapter), { force: true });
			}
			assert.equal(
				computeBindState(root),
				"foreign-bound",
				"emptied adapters: the classifier reported `bound` — the SILENT state — for a clone whose " +
					"commits fire nothing, so session start says nothing and no surface reports the disarm (§5.2)",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * Two more shapes that pass a presence probe and arm nothing: an adapter
	 * emptied in place with its exec bit intact, which git runs as a no-op,
	 * and one that lost its exec bit, which git skips. `bound` is the silent
	 * state, so classifying either as `bound` means session start says
	 * nothing about a clone whose commits fire no check at all.
	 */
	for (const shape of [
		{
			label: "emptied in place, exec bit intact",
			mutate(hooks: string): void {
				for (const adapter of ["pre-commit", "pre-push", "commit-msg"]) {
					writeFileSync(join(hooks, adapter), "");
				}
			},
		},
		{
			label: "present but not executable",
			mutate(hooks: string): void {
				for (const adapter of ["pre-commit", "pre-push", "commit-msg"]) {
					chmodSync(join(hooks, adapter), 0o644);
				}
			},
		},
	] as const) {
		it(`a bound clone whose adapters are ${shape.label} is classified degraded`, () => {
			const root = boundRepo();
			try {
				assert.equal(
					computeBindState(root),
					"bound",
					"substrate: the unmutated clone did not classify bound, so the mutation below measures nothing",
				);
				shape.mutate(join(root, ".githooks"));
				assert.equal(
					computeBindState(root),
					"foreign-bound",
					`adapters ${shape.label}: the classifier reported \`bound\` — the SILENT state — for a ` +
						"clone whose commits fire nothing, so session start says nothing and no surface " +
						"reports the disarm (§5.2)",
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("a bound clone whose hooks directory escapes the repository is classified degraded", () => {
		const root = boundRepo();
		const outside = mkdtempSync(join(tmpdir(), "gitjig-armverdict-outside-"));
		try {
			assert.equal(
				computeBindState(root),
				"bound",
				"substrate: the unmutated clone did not classify bound, so the mutation below measures nothing",
			);
			cpSync(join(root, ".githooks"), join(outside, "githooks"), { recursive: true });
			rmSync(join(root, ".githooks"), { recursive: true, force: true });
			symlinkSync(join(outside, "githooks"), join(root, ".githooks"));
			assert.equal(
				computeBindState(root),
				"foreign-bound",
				"escaping hooks link: the classifier reported `bound` for a chain the runtime refuses on every " +
					"commit — the arming verdict and the runtime it predicts must not disagree (§5.2)",
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a ~/-spelled hooks path resolving to this clone's own adapters is classified bound", () => {
		const root = boundRepo();
		const home = join(root, "home");
		const savedHome = process.env.HOME;
		try {
			assert.equal(
				computeBindState(root),
				"bound",
				"substrate: the unmutated clone did not classify bound, so the re-spelling below measures nothing",
			);
			symlinkSync(join(root, ".githooks"), join(home, "zqequiv-githooks"));
			runGit(root, home, ["config", "--local", "core.hooksPath", "~/zqequiv-githooks"]);
			// The classifier's own git child takes HOME from this process, so the
			// tilde expands inside the fixture and nothing is planted on the host.
			process.env.HOME = home;
			assert.equal(
				computeBindState(root),
				"bound",
				"tilde spelling: the classifier read a spelling git expands to this clone's own committed " +
					"adapters as foreign, and would advise a degraded state on a clone whose tier fires (§5.2)",
			);
		} finally {
			if (savedHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = savedHome;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * The stored value carries a byte the classifier's read used to discard.
	 * git escapes the newline into `.git/config`, hands it back inside the
	 * value, and resolves `<top>/.githooks<LF>` — a path that does not exist,
	 * under which no hook fires. A trimming read compares `<top>/.githooks`,
	 * which git never resolved, and answers `bound`: the SILENT state, so
	 * session start says nothing about a clone whose commits fire nothing.
	 *
	 * The byte travels as ARGV and is read back from a NUL-terminated `-z`
	 * read — a shell capture or a trimming read strips the byte under test.
	 */
	it("a hooks path whose stored value ends in a newline is classified degraded", () => {
		const root = boundRepo();
		const home = join(root, "home");
		const nlValue = `.githooks${String.fromCharCode(0x0a)}`;
		try {
			assert.equal(
				computeBindState(root),
				"bound",
				"substrate: the unmutated clone did not classify bound, so the mutation below measures nothing",
			);
			runGit(root, home, ["config", "--local", "core.hooksPath", nlValue]);
			const stored = spawnSync("git", ["config", "-z", "--local", "--path", "--get", "core.hooksPath"], {
				cwd: root,
				env: envFor(home),
				timeout: 30_000,
			});
			assert.equal(
				stored.stdout.toString("utf8"),
				`${nlValue}\0`,
				"substrate: git did not hand the value back with the byte under test, so this arm no longer " +
					"measures the shape it names",
			);
			assert.equal(
				computeBindState(root),
				"foreign-bound",
				"trailing newline: the classifier reported `bound` — the SILENT state — for a clone whose " +
					"effective hooks path is a directory that does not exist, so no hook fires and no surface " +
					"says so (§5.2)",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * git discriminates an absent key from one carried as the empty string by
	 * the read's EXIT STATUS, and the two are different clones: under an empty
	 * value git fires no hook and the operator carries a setting of their own,
	 * while an absent key is a clone that was never armed. Collapsing them
	 * makes the state token false for one of them, and the advisory that token
	 * prints names a re-arm command that refuses on it.
	 */
	it("a hooks path carried as the empty string is classified degraded, while an absent key stays unbound", () => {
		const root = boundRepo();
		const home = join(root, "home");
		try {
			assert.equal(
				computeBindState(root),
				"bound",
				"substrate: the unmutated clone did not classify bound, so the mutations below measure nothing",
			);
			runGit(root, home, ["config", "--local", "core.hooksPath", ""]);
			assert.equal(
				computeBindState(root),
				"foreign-bound",
				"empty local value: the classifier answered as if this clone carried no hooks path at all — git " +
					"fires no hook under an empty value, and the `unbound` token's own advisory names a re-arm " +
					"command that refuses on this clone (§5.2)",
			);
			runGit(root, home, ["config", "--local", "--unset", "core.hooksPath"]);
			assert.equal(
				computeBindState(root),
				"unbound",
				"absent key: a clone that carries no hooks path at all no longer classifies `unbound`, so the " +
					"token that names a genuinely unarmed clone was moved (§5.2)",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a clone reached through a symlinked path is still classified bound", () => {
		const root = boundRepo();
		const link = `${root}-link`;
		try {
			symlinkSync(root, link);
			assert.equal(
				computeBindState(link),
				"bound",
				"symlinked checkout path: a containment test taken against the caller's own unresolved cwd " +
					"answers `foreign-bound` on a clone that is bound — the refusal added for a fail-open " +
					"shape would become a false advisory on a clone that was fine",
			);
		} finally {
			rmSync(link, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
