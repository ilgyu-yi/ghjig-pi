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
import { dirname, isAbsolute, join } from "node:path";
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

/** A git child's exit status alone — `gitOut` throws on the non-zero answers several arms below read. */
function gitStatus(root: string, args: string[]): number {
	const result = spawnSync("git", args, { cwd: root, env: constructedEnv(root), timeout: 30_000 });
	return result.status ?? -1;
}

/**
 * The `git config …` act a refusal prescribes, taken from the message itself.
 * An arm that spells the act it expects measures its own spelling; an arm that
 * EXECUTES what the operator is told to run measures whether the prescription
 * is live (§3.11 — a message naming a dead recovery is worse than one naming
 * none).
 */
function prescribedGitAct(output: string): string[] {
	const match = /\((git config [^)]*)\)/.exec(output);
	assert.notEqual(match, null, `the refusal prescribes no git config act an operator could run: ${output}`);
	return (match as RegExpExecArray)[1].split(/\s+/);
}

/**
 * The stored value's own BYTES, read the way git hands them over: `-z`
 * terminates with a NUL instead of a newline, so a value that itself ends in
 * one is distinguishable from git's terminator. `gitOut` trims, which is the
 * very discard the arms below are about, so those arms read through here.
 */
function gitValueBytes(root: string, args: string[]): Buffer {
	const result = spawnSync("git", ["config", "-z", ...args], {
		cwd: root,
		env: constructedEnv(root),
		timeout: 30_000,
	});
	const out = result.stdout ?? Buffer.alloc(0);
	return out.length > 0 && out[out.length - 1] === 0 ? out.subarray(0, out.length - 1) : out;
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

// ---------------------------------------------------------------------------
// The value compared is the value git resolves — every byte of it. git stores
// a `core.hooksPath` ending in a newline and hands it back with that byte, so
// the path it resolves is `<top>/.githooks<LF>`, which does not exist and
// under which no hook fires. A capture that drops trailing newlines compares
// `<top>/.githooks` instead — a path git never resolved — and reports the
// clone verified.
//
// The byte under test travels to git as ARGV and is read back through
// `gitValueBytes`: a `$(printf …)` spelling and a trimming read alike would
// strip the very byte the arm exists to measure.
// ---------------------------------------------------------------------------

describe("the compare reads the bytes git resolves (issue #68 AC5, SPEC §4.7, §5.2)", { skip: IS_WINDOWS }, () => {
	it("a local hooks path ending in a newline fires no hook, and the run refuses rather than reporting it bound", () => {
		const fixture = buildFreshClone();
		const NL_VALUE = `.githooks${cp(0x0a)}`;
		try {
			requireInstrument(fixture.root);

			// Same-run control: armed by the ordinary spelling, THIS clone refuses
			// the staged key, so the allow measured after the mutation is the
			// mutation and not a dead fixture.
			assertBindSucceeded(runBind(fixture.root), "trailing-newline control");
			stageFile(fixture, "zqnlcontrol.txt", `${AWS_SECRET}\n`);
			const armed = commitWithMessage(fixture, "chore: control commit under the armed chain\n");
			assert.notEqual(
				armed.status,
				0,
				`trailing newline control: the armed chain passed a staged key, so this fixture measures nothing; ` +
					`stderr: ${JSON.stringify(armed.stderr)}`,
			);
			fixtureGit(fixture, ["reset", "-q", "--", "zqnlcontrol.txt"]);
			rmSync(join(fixture.root, "zqnlcontrol.txt"), { force: true });

			gitOut(fixture.root, ["config", "--local", "core.hooksPath", NL_VALUE]);
			assert.deepEqual(
				gitValueBytes(fixture.root, ["--local", "--path", "--get", "core.hooksPath"]),
				Buffer.from(NL_VALUE, "utf8"),
				"trailing newline: git did not hand the value back with the byte under test, so this arm no longer " +
					"measures the shape it names",
			);

			// The shape's whole point: under this value git fires nothing.
			stageFile(fixture, "zqnlprobe.txt", `${AWS_SECRET}\n`);
			const under = commitWithMessage(fixture, "totally invalid subject for the grammar\n");
			assert.equal(
				under.status,
				0,
				`trailing newline: git refused the commit, so the value under test is not the dead one this arm ` +
					`names; stderr: ${JSON.stringify(under.stderr)}`,
			);

			const run = runBind(fixture.root);
			assertBindRefused(run, "trailing-newline local value");
			assert.deepEqual(
				gitValueBytes(fixture.root, ["--local", "--path", "--get", "core.hooksPath"]),
				Buffer.from(NL_VALUE, "utf8"),
				"trailing newline: the refused run rewrote a value another writer owns (§4.7)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The success line names TWO properties, so both are verified before it is
// printed. The exclusion half is a write followed by no re-read: git's own
// precedence lets a rule outside the resolved `info/exclude` decide the path,
// and the line the run appends then changes nothing at all.
// ---------------------------------------------------------------------------

describe("the exclusion the success line claims is re-measured after the append (issue #68 AC4, SPEC §4.1)", { skip: IS_WINDOWS }, () => {
	it("a rule that outranks the resolved info/exclude makes the run refuse instead of reporting a verified bound state", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			writeFileSync(join(fixture.root, ".gitignore"), "!/.ghjig/\n");
			fixtureGit(fixture, ["add", "--", ".gitignore"]);
			fixtureGit(fixture, ["commit", "--no-verify", "-q", "-m", "chore: a rule outranking info/exclude"]);

			// Same-run control: the fallback path really is the live one here, so
			// the run below reaches the append this arm is about.
			assert.equal(
				spawnSync("git", ["check-ignore", "-q", "--", ".ghjig/state/audit.jsonl"], {
					cwd: fixture.root,
					env: constructedEnv(fixture.root),
					timeout: 30_000,
				}).status,
				1,
				"exclusion re-measure: the fixture already ignores .ghjig/, so the run takes the no-write fast path " +
					"and this arm measures nothing",
			);

			const run = runBind(fixture.root);
			assertBindRefused(run, "exclusion defeated by an outranking rule");
			assert.equal(
				run.output.includes("bound: verified"),
				false,
				`exclusion re-measure: the run reported a verified bound state while git still does not ignore ` +
					`.ghjig/ — the success line names an exclusion that does not hold (§4.1): ${run.output}`,
			);
			assert.equal(
				spawnSync("git", ["check-ignore", "-q", "--", ".ghjig/state/audit.jsonl"], {
					cwd: fixture.root,
					env: constructedEnv(fixture.root),
					timeout: 30_000,
				}).status,
				1,
				"exclusion re-measure: git now ignores the path, so the refusal above was about a shape that " +
					"repaired itself and the arm measures nothing",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The append writes into a file another writer owns, and `git help gitignore`
// says what that file is: "Each line in a gitignore file specifies a pattern".
// Two consequences, neither reachable from any arm above — the write-set arm
// matches on path membership, and the byte-identity arm is scoped to the
// clone where the fallback never runs: an unterminated final line is still
// the operator's last rule, and membership in the file is a LINE, so the
// re-run the exclusion refusal prescribes must add nothing.
// ---------------------------------------------------------------------------

describe("the exclusion append reads info/exclude as line-oriented (issue #68 AC4, SPEC §4.1, §4.7)", { skip: IS_WINDOWS }, () => {
	it("an operator rule on an unterminated final line still decides its own path after the run", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			const excludePath = resolvedExcludePath(fixture.root);
			mkdirSync(dirname(excludePath), { recursive: true });
			writeFileSync(join(fixture.root, "zqkeep.env"), "zqcontents\n");
			// The byte under test is the ABSENT terminator, so the rule is
			// written without one and never through a helper that adds it.
			writeFileSync(excludePath, "/zqkeep.env");

			// Control: git honours the unterminated rule BEFORE the run, so what
			// the assertions below measure is the run and not a dead fixture.
			assert.equal(
				gitStatus(fixture.root, ["check-ignore", "-q", "--", "zqkeep.env"]),
				0,
				"unterminated rule: git does not honour the fixture's rule to begin with, so this arm measures nothing",
			);
			assert.equal(
				gitStatus(fixture.root, ["check-ignore", "-q", "--", ".ghjig/state/audit.jsonl"]),
				1,
				"unterminated rule: the clone already ignores .ghjig/, so the run takes the no-write fast path and " +
					"never reaches the append this arm is about",
			);

			assertBindSucceeded(runBind(fixture.root), "unterminated operator rule");

			assert.equal(
				gitStatus(fixture.root, ["check-ignore", "-q", "--", "zqkeep.env"]),
				0,
				`unterminated rule: the run destroyed a rule it does not own — git no longer ignores zqkeep.env ` +
					`(§4.7 never-overwrite): ${JSON.stringify(readFileSync(excludePath, "utf8"))}`,
			);
			assert.equal(
				readFileSync(excludePath, "utf8").split("\n")[0],
				"/zqkeep.env",
				`unterminated rule: the operator's last line no longer stands alone: ` +
					`${JSON.stringify(readFileSync(excludePath, "utf8"))}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the shape whose own refusal prescribes a re-run holds at one exclusion line across three runs", () => {
		const fixture = buildFreshClone();
		try {
			requireInstrument(fixture.root);
			writeFileSync(join(fixture.root, ".gitignore"), "!/.ghjig/\n");
			fixtureGit(fixture, ["add", "--", ".gitignore"]);
			fixtureGit(fixture, ["commit", "--no-verify", "-q", "-m", "chore: a rule outranking info/exclude"]);
			// Control: the fallback really is the live path here, so each run
			// below reaches the append and the refusal that prescribes the next.
			assert.equal(
				gitStatus(fixture.root, ["check-ignore", "-q", "--", ".ghjig/state/audit.jsonl"]),
				1,
				"re-run accumulation: the fixture already ignores .ghjig/, so no run reaches the append",
			);

			const excludePath = resolvedExcludePath(fixture.root);
			for (let run = 1; run <= 3; run += 1) {
				assertBindRefused(runBind(fixture.root), `re-run accumulation, run ${run}`);
			}

			const appended = readFileSync(excludePath, "utf8")
				.split("\n")
				.filter((line) => line === "/.ghjig/");
			assert.equal(
				appended.length,
				1,
				`re-run accumulation: the resolved info/exclude carries ${appended.length} '/.ghjig/' lines after ` +
					`three runs — the refusal prescribes the re-run, so the growth is by instruction (§4.7 ` +
					`safe-to-repeat): ${JSON.stringify(readFileSync(excludePath, "utf8"))}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// `git help config` on --includes: "Defaults to off when a specific file is
// given (e.g., using --file, --global, etc) and on when searching all config
// files." So a `--local` read is blind to a value the LOCAL scope nonetheless
// resolves through an `[include]`, and `--show-scope` reports that value as
// `local`. Both directions of the write decision ride on that read.
// ---------------------------------------------------------------------------

describe("the local read sees what the local scope resolves (issue #68 AC3, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("a foreign hooks path the local scope resolves through an include is refused, not silently outranked", () => {
		const fixture = buildFreshClone();
		try {
			const other = join(fixture.root, "zqincludehooks");
			mkdirSync(other);
			writeFileSync(join(fixture.root, ".git", "zqinc.cfg"), `[core]\n\thooksPath = ${other}\n`);
			// The include goes ABOVE everything already in the file, so git's
			// last-value rule would hand any line this run writes the resolution
			// — which is the direction that loses the operator's value silently.
			const configPath = join(fixture.root, ".git", "config");
			writeFileSync(configPath, `[include]\n\tpath = zqinc.cfg\n${readFileSync(configPath, "utf8")}`);

			// Controls: this is the value git resolves, and `local` is the scope
			// git names for it — so the write decision's own scope carries it.
			assert.equal(
				gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				other,
				"include-carried value: git does not resolve the include here, so this arm measures nothing",
			);
			assert.equal(
				gitOut(fixture.root, ["config", "--show-scope", "--get", "core.hooksPath"]).split("\t")[0],
				"local",
				"include-carried value: git does not report this value at local scope, so the arm no longer names " +
					"the shape it measures",
			);
			requireInstrument(fixture.root);

			const run = runBind(fixture.root);
			assertBindRefused(run, "include-carried foreign local value");
			assert.equal(
				gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				other,
				`include-carried value: the run took over a hooks path another writer owns — a value the local ` +
					`scope resolves is that target's choice whichever file carries it (§4.7): ${run.output}`,
			);
			// The act the refusal prescribes, executed verbatim: `--unset` at a
			// scope that resolves the value through an include removes nothing.
			assert.equal(
				gitStatus(fixture.root, prescribedGitAct(run.output).slice(1)),
				0,
				`include-carried value: the act the refusal prescribes is dead on the shape that reached the ` +
					`message (§3.11): ${run.output}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a clone bound to the committed adapters THROUGH an include arms rather than refusing", () => {
		const fixture = buildFreshClone();
		try {
			writeFileSync(join(fixture.root, ".git", "zqinc.cfg"), "[core]\n\thooksPath = .githooks\n");
			const configPath = join(fixture.root, ".git", "config");
			writeFileSync(configPath, `${readFileSync(configPath, "utf8")}[include]\n\tpath = zqinc.cfg\n`);

			// Control: this binding's chain actually fires, so a refusal below
			// would be a refusal of a genuinely armed clone.
			stageFile(fixture, "zqincleak.txt", `${AWS_SECRET}\n`);
			const armed = commitWithMessage(fixture, "chore: exercise the include-bound chain\n");
			assert.notEqual(
				armed.status,
				0,
				`include-bound clone: the chain does not fire under this binding, so the arm measures nothing; ` +
					`stderr: ${JSON.stringify(armed.stderr)}`,
			);
			fixtureGit(fixture, ["reset", "-q", "--", "zqincleak.txt"]);
			rmSync(join(fixture.root, "zqincleak.txt"), { force: true });
			requireInstrument(fixture.root);

			assertBindSucceeded(runBind(fixture.root), "bound through an include");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// `git help config` EXIT STATUS: "you try to unset/set an option for which
// multiple lines match (ret=5)", and on `get`: "If key is present multiple
// times in the configuration, emits the last value." So a multi-valued key
// reaches both refusals below with rc 0 while `--unset` is dead there. Each
// arm RUNS the act the message prescribes rather than matching its spelling.
// ---------------------------------------------------------------------------

describe("every prescribed act is live at the shape that reached it (issue #68 AC8, SPEC §3.11)", { skip: IS_WINDOWS }, () => {
	it("a multi-valued local hooks path is refused with an act that survives the multiplicity", () => {
		const fixture = buildFreshClone();
		try {
			const first = join(fixture.root, "zqmultihooksa");
			const second = join(fixture.root, "zqmultihooksb");
			mkdirSync(first);
			mkdirSync(second);
			gitOut(fixture.root, ["config", "--local", "core.hooksPath", first]);
			gitOut(fixture.root, ["config", "--local", "--add", "core.hooksPath", second]);
			// Control: the clone really carries two lines at this scope.
			assert.equal(
				gitOut(fixture.root, ["config", "--local", "--get-all", "core.hooksPath"]).split("\n").length,
				2,
				"multi-valued local: the fixture does not carry two values, so this arm measures nothing",
			);
			requireInstrument(fixture.root);

			const run = runBind(fixture.root);
			assertBindRefused(run, "multi-valued local hooks path");
			const act = prescribedGitAct(run.output);
			assert.equal(
				gitStatus(fixture.root, act.slice(1)),
				0,
				`multi-valued local: the act the refusal prescribes (${act.join(" ")}) exited non-zero, so an ` +
					`operator following the message reaches the same refusal again (§3.11): ${run.output}`,
			);
			assertBindSucceeded(runBind(fixture.root), "multi-valued local, after the prescribed act");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a multi-valued worktree hooks path is refused with an act that survives the multiplicity", () => {
		const fixture = buildFreshClone();
		try {
			const first = join(fixture.root, "zqwtmultia");
			const second = join(fixture.root, "zqwtmultib");
			mkdirSync(first);
			mkdirSync(second);
			gitOut(fixture.root, ["config", "extensions.worktreeConfig", "true"]);
			gitOut(fixture.root, ["config", "--worktree", "core.hooksPath", first]);
			gitOut(fixture.root, ["config", "--worktree", "--add", "core.hooksPath", second]);
			gitOut(fixture.root, ["config", "--local", "core.hooksPath", ".githooks"]);
			// Control: the overriding value really is at worktree scope, which is
			// the scope the refusal composes its act for.
			assert.equal(
				gitOut(fixture.root, ["config", "--show-scope", "--get", "core.hooksPath"]).split("\t")[0],
				"worktree",
				"multi-valued worktree: git does not resolve the worktree scope here, so this arm measures nothing",
			);
			requireInstrument(fixture.root);

			const run = runBind(fixture.root);
			assertBindRefused(run, "multi-valued worktree hooks path");
			const act = prescribedGitAct(run.output);
			assert.equal(
				gitStatus(fixture.root, act.slice(1)),
				0,
				`multi-valued worktree: the act the refusal prescribes (${act.join(" ")}) exited non-zero, so an ` +
					`operator following the message reaches the same refusal again (§3.11): ${run.output}`,
			);
			assertBindSucceeded(runBind(fixture.root), "multi-valued worktree, after the prescribed act");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
