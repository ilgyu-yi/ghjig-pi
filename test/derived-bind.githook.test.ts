/**
 * Behavioral suite for the arming instrument of a tier that derives its own
 * locations (issue #68's amended AC1/AC2/AC3; SPEC §3.2's arming path, §4.1
 * exclusion at creation, §4.2 no generated code beside the committed bytes,
 * §4.7 idempotence / never-overwrite-another-writer / scope split).
 *
 * Subject under test: `bash .githooks/bind_local_tier.sh` in the fixture's
 * byte-verified copy of THIS repository's `.githooks/` tree, driven as an
 * operator runs it. What the instrument leaves behind is measured twice:
 * once at the observable state (`core.hooksPath`, the exclusion, the shell's
 * own namespace) and once through `git commit`, never through a predicate
 * called directly.
 *
 * ANTI-VACUITY. A missing instrument satisfies any "non-success" clause by
 * itself (bash exits 127), so every arm opens with `requireInstrument`, and
 * every refusal assertion goes through `assertBindRefused`, which rejects
 * 127 and a timeout kill as decisions. Arms that hold over any write set the
 * instrument can carry are declared BOUNDARY PINS in place, each stating
 * what mutation reddens it.
 *
 * FIXTURE DISCIPLINE. The whole `.githooks` tree is copied and byte-verified
 * by `buildGithookFixture` — copying `helpers/*.sh` alone drops the
 * extensionless `helpers/secret-patterns` and every measured allow becomes
 * meaningless. Fixtures mint their own state; no arm reads this clone's own
 * `.ghjig/`.
 *
 * Environment constraints (sibling-suite doctrine): secret material is BUILT
 * FROM CODEPOINTS, `zq…` markers guard every byte-level assertion, every
 * spawn is timeout-wrapped, POSIX substrate only.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import {
	buildGithookFixture,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { AUDIT_FILE_NAME, listTreeEntries } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";
const cp = String.fromCharCode;

const INSTRUMENT_REL = join(".githooks", "bind_local_tier.sh");
const NO_INSTRUMENT =
	"the fixture carries no .githooks/bind_local_tier.sh — the copied tree is incomplete, so every " +
	"assertion past this point would measure the absence rather than the instrument";

const PROTECTED = "zqbindtrunk2zq";
const FEATURE = "zqbindfeat2zq";

/** "AKIA" — assembled from codepoints, never literal in this source. */
const AKIA = cp(0x41, 0x4b, 0x49, 0x41);
const AWS_SECRET = AKIA + "IOSFODNN7EXAMPLE";
const AWS_PATTERN_ID = "aws-access-key-id";

/** The retired per-clone binding path — a file the instrument no longer writes. */
const RETIRED_BINDING_REL = join(".ghjig", "shell-adapter.sh");

// ---------------------------------------------------------------------------
// Substrate helpers.
// ---------------------------------------------------------------------------

function constructedEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(root, "home"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		...extra,
	};
}

interface InstrumentRun {
	status: number | null;
	stdout: string;
	stderr: string;
	/** Both streams — the wording pins read either surface. */
	output: string;
}

function requireInstrument(root: string): void {
	assert.equal(
		existsSync(join(root, INSTRUMENT_REL)),
		true,
		`${NO_INSTRUMENT} (expected the fixture copy at ${join(root, INSTRUMENT_REL)})`,
	);
}

function runBind(root: string, args: string[] = []): InstrumentRun {
	const result = spawnSync("bash", [join(root, INSTRUMENT_REL), ...args], {
		cwd: root,
		env: constructedEnv(root),
		timeout: 30_000,
	});
	const stdout = (result.stdout ?? Buffer.alloc(0)).toString("utf8");
	const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8");
	return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

function assertBindSucceeded(run: InstrumentRun, arm: string): void {
	assert.equal(
		run.status,
		0,
		`${arm}: the run did not report a verified bound state; status=${run.status}\n${run.output}`,
	);
}

/** Non-success that is a DECISION, not a timeout kill or a 127 file miss. */
function assertBindRefused(run: InstrumentRun, arm: string): void {
	assert.notEqual(run.status, null, `${arm}: the run hung and was killed`);
	assert.notEqual(run.status, 0, `${arm}: the run reported success on a state it must refuse`);
	assert.notEqual(run.status, 127, `${arm}: exit 127 is the missing-file shape, not the instrument's refusal`);
}

function gitOut(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, env: constructedEnv(root), timeout: 30_000 });
	if (result.status !== 0) {
		throw new Error(`substrate: git ${args.join(" ")} exited ${result.status}: ${result.stderr?.toString("utf8")}`);
	}
	return (result.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
}

/** The exclude file `git rev-parse --git-path info/exclude` resolves — never the literal `.git/info/exclude`. */
function resolvedExcludePath(root: string): string {
	const raw = gitOut(root, ["rev-parse", "--git-path", "info/exclude"]);
	return isAbsolute(raw) ? raw : join(root, raw);
}

function readOrNull(path: string): Buffer | null {
	return existsSync(path) ? readFileSync(path) : null;
}

/** Everything under the shell's own untracked namespace, or `[]` where it is absent. */
function namespaceEntries(root: string): string[] {
	return existsSync(join(root, ".ghjig")) ? listTreeEntries(join(root, ".ghjig")).sort() : [];
}

function stageFile(fixture: GithookFixture, name: string, content: string): void {
	writeFileSync(join(fixture.root, name), content);
	fixtureGit(fixture, ["add", "--", name]);
}

/** A fresh clone: the committed tree, a derivable protected identity, no binding of any kind. */
function buildFreshClone(): GithookFixture {
	const fixture = buildGithookFixture({ unbound: true, remote: { defaultBranch: PROTECTED } });
	fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);
	return fixture;
}

// ---------------------------------------------------------------------------
// AC1 — fresh clone, one run.
// ---------------------------------------------------------------------------

describe("one run arms a fresh clone and writes no per-clone code (issue #68 AC1, SPEC §3.2, §4.2)", { skip: IS_WINDOWS }, () => {
	it("after one run the clone refuses a staged secret with the pattern ID on the record, passes a clean commit, and carries no file at the retired binding path", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "fresh clone");

			assert.equal(
				existsSync(join(fixture.root, RETIRED_BINDING_REL)),
				false,
				`fresh clone: the run generated a file at ${RETIRED_BINDING_REL} — a location a clone needs is ` +
					`derived at run time from the running file's own installed position and the repository top, ` +
					`never generated as code beside the committed bytes (§4.2)`,
			);

			const porcelain = gitOut(fixture.root, ["status", "--porcelain"]);
			assert.equal(
				porcelain.split("\n").some((line) => line.includes(".ghjig")),
				false,
				`fresh clone: the shell's untracked namespace is visible to version control — it is excluded at ` +
					`creation (§4.1, §5.5): ${porcelain}`,
			);

			stageFile(fixture, "zqfreshleak.txt", `${AWS_SECRET}\n`);
			const refused = commitWithMessage(fixture, "chore: exercise the fresh-clone refusal\n");
			assert.notEqual(
				refused.status,
				0,
				`fresh clone: the staged key passed after a verified run; stderr: ${JSON.stringify(refused.stderr)}`,
			);
			assert.equal(
				refused.auditDelta.includes(AWS_PATTERN_ID),
				true,
				`fresh clone: the record at .ghjig/state/${AUDIT_FILE_NAME} does not name pattern ` +
					`'${AWS_PATTERN_ID}' (§3.3, §4.6): ${JSON.stringify(refused.auditDelta)}`,
			);
			assert.equal(
				Buffer.from(refused.auditDelta, "utf8").includes(Buffer.from(AWS_SECRET, "utf8")),
				false,
				"fresh clone: the planted key's bytes reached the record (§3.8's refusal-record rule)",
			);

			fixtureGit(fixture, ["reset", "-q", "--", "zqfreshleak.txt"]);
			rmSync(join(fixture.root, "zqfreshleak.txt"), { force: true });
			const clean = commitWithMessage(fixture, "chore: exercise the fresh-clone clean commit\n");
			assert.equal(
				clean.status,
				0,
				`fresh clone: an ordinary commit was refused by the armed chain; stderr: ${JSON.stringify(clean.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// AC2 — idempotence.
// ---------------------------------------------------------------------------

describe("a second run mutates nothing and says so (issue #68 AC2, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	// BOUNDARY PIN: the unchanged-state half of idempotence holds whatever the
	// instrument's write set is, so it does not separate one write set from
	// another. What reddens it is a run that appends a second exclusion line,
	// rewrites the activation, or leaves the namespace it found. The write set
	// itself is the census arm's subject, below.
	it("BOUNDARY PIN: the second run leaves the effective hooks path, the exclusion and the shell's namespace byte-identical", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "idempotence first run");

			const excludePath = resolvedExcludePath(fixture.root);
			const before = {
				effective: gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				exclude: readOrNull(excludePath),
				namespace: namespaceEntries(fixture.root),
			};

			const second = runBind(fixture.root);
			assertBindSucceeded(second, "idempotence second run");

			assert.equal(
				gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				before.effective,
				"idempotence: the second run changed the effective core.hooksPath (§4.7)",
			);
			assert.deepEqual(
				readOrNull(excludePath),
				before.exclude,
				`idempotence: the second run rewrote the resolved exclusion at ${excludePath} — a re-run appends ` +
					`no second exclusion line (§4.7)`,
			);
			assert.deepEqual(
				namespaceEntries(fixture.root),
				before.namespace,
				"idempotence: the second run changed the shell's own untracked namespace (§4.7)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	// BOUNDARY PIN: the no-op wording is owed by every write set the
	// instrument can carry. What reddens it is a second run that reports a
	// fresh arming, or reports nothing at all.
	it("BOUNDARY PIN: the second run names what already holds", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "no-op wording first run");
			const second = runBind(fixture.root);
			assertBindSucceeded(second, "no-op wording second run");
			assert.match(
				second.output,
				/already|no-op|unchanged/i,
				`idempotence: the second run does not name what already holds, so an operator cannot tell a ` +
					`re-run that changed nothing from one that rewrote the clone (§4.7): ${second.output}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("no run of the instrument leaves a file at the retired binding path", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "census first run");
			assertBindSucceeded(runBind(fixture.root), "census second run");
			assert.deepEqual(
				namespaceEntries(fixture.root).filter((entry) => entry.includes("shell-adapter")),
				[],
				`idempotence: the instrument's write set under the shell's namespace includes a per-clone ` +
					`binding file — the tier's runtime and its delegated checks are committed code of the ` +
					`repository under work (§3.2, §4.2)`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// AC3 — a `core.hooksPath` this instrument did not set is never overwritten.
// ---------------------------------------------------------------------------

describe("a foreign hooks path is never overwritten (issue #68 AC3, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	// BOUNDARY PIN: the never-overwrite obligation is older than this change
	// and holds over either write set. What reddens it is a run that takes a
	// target another writer owns, or one that refuses without naming the
	// configuration and the scope carrying it. The write set the refused run
	// leaves is the arm after it.
	it("BOUNDARY PIN: a foreign value in the clone's own config survives the refused run byte-identical", () => {
		const fixture = buildFreshClone();
		try {
			const other = join(fixture.root, "zqforeignhooks");
			mkdirSync(other);
			gitOut(fixture.root, ["config", "--local", "core.hooksPath", other]);
			requireInstrument(fixture.root);

			const run = runBind(fixture.root);
			assertBindRefused(run, "foreign local hooks path");
			assert.equal(
				gitOut(fixture.root, ["config", "--local", "--get", "core.hooksPath"]),
				other,
				"foreign local hooks path: the run rewrote a value another writer owns (§4.7)",
			);
			assert.match(
				run.output,
				/hooksPath/,
				`foreign local hooks path: the refusal does not name the configuration it refused to touch, so ` +
					`the operator is left the consequence and no place to act (§3.11): ${run.output}`,
			);
			assert.match(
				run.output,
				/local/i,
				`foreign local hooks path: the refusal does not name the scope carrying the value — a scope the ` +
					`message does not name is one the operator cannot clear (§4.7): ${run.output}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a refused run against a foreign local value leaves the shell's namespace untouched", () => {
		const fixture = buildFreshClone();
		try {
			const other = join(fixture.root, "zqforeignhooks");
			mkdirSync(other);
			gitOut(fixture.root, ["config", "--local", "core.hooksPath", other]);
			requireInstrument(fixture.root);

			assertBindRefused(runBind(fixture.root), "foreign local hooks path, write set");
			assert.deepEqual(
				namespaceEntries(fixture.root),
				[],
				`foreign local hooks path: the refused run left state under .ghjig/ — the run that refuses to ` +
					`take another writer's target writes nothing of its own (§4.7)`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	// BOUNDARY PIN: the scope split holds over either write set. What reddens
	// it is a verification that reads the local scope alone and so certifies a
	// clone whose committed hooks never fire.
	it("BOUNDARY PIN: a foreign value at worktree scope, which the local activation cannot outrank, makes the run refuse and name that scope", () => {
		const fixture = buildFreshClone();
		try {
			const other = join(fixture.root, "zqworktreehooks");
			mkdirSync(other);
			gitOut(fixture.root, ["config", "extensions.worktreeConfig", "true"]);
			gitOut(fixture.root, ["config", "--worktree", "core.hooksPath", other]);
			// Positive control: this really is the value git resolves, so the
			// refusal below is about a live divergence, not a hypothesis.
			assert.equal(
				gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				other,
				"worktree scope: git does not resolve the worktree-scope value here — the arm no longer measures " +
					"the shape it names",
			);
			requireInstrument(fixture.root);

			const run = runBind(fixture.root);
			assertBindRefused(run, "worktree-scope override");
			assert.match(
				run.output,
				/worktree/i,
				`worktree scope: the refusal does not name the scope carrying the overriding value (§4.7): ${run.output}`,
			);
			assert.equal(
				gitOut(fixture.root, ["config", "--worktree", "--get", "core.hooksPath"]),
				other,
				"worktree scope: the run rewrote the worktree-scope value it must leave alone (§4.7)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a refused run against a worktree-scope value leaves the shell's namespace untouched", () => {
		const fixture = buildFreshClone();
		try {
			const other = join(fixture.root, "zqworktreehooks");
			mkdirSync(other);
			gitOut(fixture.root, ["config", "extensions.worktreeConfig", "true"]);
			gitOut(fixture.root, ["config", "--worktree", "core.hooksPath", other]);
			requireInstrument(fixture.root);

			assertBindRefused(runBind(fixture.root), "worktree-scope override, write set");
			assert.deepEqual(
				namespaceEntries(fixture.root),
				[],
				`worktree scope: the refused run left state under .ghjig/ — a run that reports no verified bound ` +
					`state leaves no per-clone artifact behind it (§4.7)`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
