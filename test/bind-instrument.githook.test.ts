/**
 * Behavioral suite for the committed arming instrument and the tier's own
 * record writer (issue #68 ACs; SPEC §3.2 arming path, §4.1 exclusion at
 * creation, §4.6 writer-path=reader-path, §4.7
 * idempotence/skip-warn/resolved-equivalence/root-only/host boundary, §5.5).
 *
 * Subject under test: `bash .githooks/bind_local_tier.sh` — the fixture's
 * byte-verified copy of THIS repository's `.githooks/` tree, driven as an
 * operator runs it, and the chain it arms measured only through `git
 * commit` (never a predicate directly). The record sink is the path the
 * tier DERIVES, `<top>/.gitjig/state/audit.jsonl` — exactly
 * `resolveStateRoot()`'s root joined with `AUDIT_FILE_NAME` (§4.6) — which
 * is what `commitWithMessage`'s delta reads.
 *
 * The state-set and fresh-clone arms live in the sibling suites
 * (`derived-bind.githook.test.ts`, `derived-tier.githook.test.ts`); what is
 * here is what those do not measure: the instrument's write set and host
 * boundary, the exclusion's two paths, the scope split's ambient half, the
 * environment scrub, and the record writer's own hostile-input and
 * mixed-writer bounds.
 *
 * ANTI-VACUITY. A missing instrument satisfies a bind arm's clauses by
 * itself (bash exits 127), so every arm whose remaining assertions could
 * pass against an absent file opens with `requireInstrument`.
 *
 * Environment constraints (sibling doctrine, stated in place):
 *   - every secret fragment and hostile byte is BUILT FROM CODEPOINTS,
 *     never literal, so the shell's own staged-secret matcher cannot trip
 *     on this source and byte-absence assertions stay honest;
 *   - distinctive `zq…` markers everywhere a byte-absence or byte-presence
 *     assertion runs, so incidental git output cannot collide;
 *   - every spawn is timeout-wrapped;
 *   - POSIX substrate only: the suite skips on win32.
 *
 * PINNED SPELLINGS (the wording contract this suite and the tier share):
 *   - the Δ1 equivalence no-op names the equivalence via /equivalen/i;
 *   - a fold that does not finish sourcing says `not enforced` plainly.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	appendFileSync,
	chmodSync,
	closeSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { describe, it } from "node:test";
import { appendAuditRecord } from "../.pi/extensions/gitjig/audit.ts";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { AUDIT_FILE_NAME, listTreeEntries, listTreeSizes, repoRoot } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";
const cp = String.fromCharCode;

const INSTRUMENT_REL = join(".githooks", "bind_local_tier.sh");
const LIB_REL = join(".githooks", "_lib.sh");
const NO_INSTRUMENT =
	"the fixture carries no .githooks/bind_local_tier.sh — the copied tree is incomplete, so every " +
	"assertion past this point would measure the absence rather than the instrument";

/** Distinctive branch names (header note). */
const PROTECTED = "zqbindtrunkzq";
const FEATURE = "zqbindfeatzq";

// Runtime-built secret material (header note: never literal in source).
/** "AKIA" — assembled from codepoints. */
const AKIA = cp(0x41, 0x4b, 0x49, 0x41);
const AWS_SECRET = AKIA + "ZQ0BINDZQ4PLANT9"; // prefix + 16 × [A-Z0-9]
const AWS_PATTERN_ID = "aws-access-key-id";

// ---------------------------------------------------------------------------
// Substrate helpers.
// ---------------------------------------------------------------------------

function opSink(root: string): string {
	return join(root, ".gitjig", "state", AUDIT_FILE_NAME);
}

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
	/** Both streams — the warn/no-op wording pins read either surface. */
	output: string;
}

/**
 * The honest red gate (header note): an arm whose remaining assertions
 * could green vacuously against a missing instrument states the absence
 * as its own failure.
 */
function requireInstrument(root: string): void {
	assert.equal(
		existsSync(join(root, INSTRUMENT_REL)),
		true,
		`${NO_INSTRUMENT} (expected the fixture copy at ${join(root, INSTRUMENT_REL)})`,
	);
}

function runBind(
	root: string,
	args: string[] = [],
	options: { cwd?: string; env?: Record<string, string> } = {},
): InstrumentRun {
	const result = spawnSync("bash", [join(root, INSTRUMENT_REL), ...args], {
		cwd: options.cwd ?? root,
		env: constructedEnv(root, options.env ?? {}),
		timeout: 30_000, // header doctrine: every spawn is timeout-wrapped
	});
	const stdout = (result.stdout ?? Buffer.alloc(0)).toString("utf8");
	const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8");
	return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

function assertBindSucceeded(run: InstrumentRun, arm: string): void {
	assert.equal(
		run.status,
		0,
		`${arm}: the bind run did not report a verified bound state; ` +
			`status=${run.status}\n${run.output}`,
	);
}

/** Run one fixture-scoped git command that must succeed; return trimmed stdout. */
function gitOut(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, env: constructedEnv(root), timeout: 30_000 });
	if (result.status !== 0) {
		throw new Error(`substrate: git ${args.join(" ")} exited ${result.status}: ${result.stderr?.toString("utf8")}`);
	}
	return (result.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
}

/**
 * `git config --local --get <name>` in the fixture — "" when the LOCAL
 * scope carries nothing. Never throws: for the scope-split arms an unset
 * local value is the measurement itself (the persistent activation is
 * missing), not a substrate failure, so it must reach the arm's own
 * assertion message rather than `gitOut`'s.
 */
function localConfig(root: string, name: string): string {
	const result = spawnSync("git", ["config", "--local", "--get", name], {
		cwd: root,
		env: constructedEnv(root),
		timeout: 30_000,
	});
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

/**
 * `git commit` through the fixture's chain, timeout-wrapped, with both child
 * streams landing in a FILE rather than a pipe. `commitWithMessage` is every
 * other arm's route; this one exists for the arm whose hostile object is the
 * SINK itself, which that route cannot measure: it reads the sink by name to
 * compute its delta (a read that parks on a FIFO), and it drains the child's
 * pipes to EOF (a drain a parked hook holds open past the kill). A returned
 * `status === null` is exactly the park this arm must be able to see.
 */
function commitTimed(fixture: GithookFixture, subject: string, timeoutMs: number): number | null {
	fixture.seq += 1;
	appendFileSync(join(fixture.root, "work.txt"), `change ${fixture.seq}\n`);
	fixtureGit(fixture, ["add", "work.txt"]);
	const outFd = openSync(join(fixture.root, "zqcommit-streams.txt"), "w");
	try {
		return spawnSync("git", ["commit", "-q", "-m", subject], {
			cwd: fixture.root,
			env: constructedEnv(fixture.root),
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			stdio: ["ignore", outFd, outFd],
		}).status;
	} finally {
		closeSync(outFd);
	}
}

/**
 * Release a writer parked on a reader-less FIFO: opening the read end is
 * what its blocking open is waiting for. Cleanup only — a parked hook
 * outlives the fixture removal otherwise (unlinking a FIFO does not wake a
 * process already blocked in `open`), and it is deliberately NOT part of any
 * measurement: it runs after the arm has decided.
 */
function unparkFifo(path: string): void {
	try {
		closeSync(openSync(path, constants.O_RDONLY | constants.O_NONBLOCK));
	} catch {
		// Nothing parked, or the path is gone — either way there is nothing to release.
	}
}

/** Write + stage one worktree file (setup substrate). */
function stageFile(fixture: GithookFixture, name: string, content: string | Buffer): void {
	writeFileSync(join(fixture.root, name), content);
	fixtureGit(fixture, ["add", "--", name]);
}

/**
 * The armed-refusal observable on the derived sink (§3.3, §4.6): block
 * record naming the secret class, pattern ID on both refusal surfaces,
 * non-zero commit, secret bytes on no surface.
 */
function assertSecretRefused(attempt: CommitAttempt, stagedPath: string, arm: string): void {
	assert.match(
		attempt.auditDelta,
		/\bblock\b.*\bsecret\b/,
		`${arm}: no block record naming the secret class reached the derived sink — the chain the ` +
			`activated hooks path arms did not fire; delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.notEqual(attempt.status, 0, `${arm}: the guarded commit SUCCEEDED through the armed chain`);
	assert.equal(
		attempt.stderr.includes(AWS_PATTERN_ID),
		true,
		`${arm}: the refusal's stderr does not name pattern '${AWS_PATTERN_ID}' (§3.3)`,
	);
	assert.equal(
		attempt.auditDelta.includes(AWS_PATTERN_ID),
		true,
		`${arm}: the audit record does not name pattern '${AWS_PATTERN_ID}' (§3.3)`,
	);
	assert.equal(
		attempt.auditDelta.includes(stagedPath),
		true,
		`${arm}: the audit record does not name the offending path`,
	);
	for (const [surface, bytes] of [
		["stderr", attempt.stderrBytes],
		["stdout", attempt.stdoutBytes],
		["the audit delta", Buffer.from(attempt.auditDelta, "utf8")],
	] as const) {
		assert.equal(
			bytes.includes(Buffer.from(AWS_SECRET, "utf8")),
			false,
			`${arm}: the planted secret's bytes reached ${surface} (§3.8)`,
		);
	}
}

/**
 * A fixture armed the way a clone arms itself — `core.hooksPath` alone —
 * with a derivable protected identity and a feature branch checked out.
 */
function buildArmedScanFixture(): GithookFixture {
	const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
	fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);
	return fixture;
}

// ---------------------------------------------------------------------------
// Hostile-bytes repository root (§4.2: no path is baked, and none is quoted
// into generated bytes — the derivation has to survive the bytes anyway).
// ---------------------------------------------------------------------------

describe("a hostile-bytes repository root binds and fires (issue #68, SPEC §4.2)", { skip: IS_WINDOWS }, () => {
	it("a root carrying quote, space, dollar and backtick binds, and the armed chain refuses a staged secret", () => {
		// Dir name from codepoints (header note): "zqh '<quote>$d`t" —
		// space, 0x27, 0x24, 0x60 all inside one path segment.
		const base = mkdtempSync(join(tmpdir(), "gitjig-bindhostile-"));
		const hostileName = "zqh " + cp(0x27) + cp(0x24) + "d" + cp(0x60) + "t";
		const root = join(base, hostileName);
		try {
			mkdirSync(join(root, "home"), { recursive: true });
			cpSync(join(repoRoot(), ".githooks"), join(root, ".githooks"), { recursive: true });
			const fixture: GithookFixture = {
				root,
				helpersDir: join(root, ".githooks", "helpers"),
				auditFile: opSink(root),
				seq: 0,
			};
			fixtureGit(fixture, ["-c", "init.defaultBranch=zqhostmain", "init", "-q"]);
			fixtureGit(fixture, ["config", "user.name", "fixture"]);
			fixtureGit(fixture, ["config", "user.email", "fixture@invalid"]);
			fixtureGit(fixture, ["config", "commit.gpgsign", "false"]);

			requireInstrument(root);
			assertBindSucceeded(runBind(root), "hostile root bind");
			stageFile(fixture, "zqhostileleak.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the hostile-root arm\n");
			assertSecretRefused(attempt, "zqhostileleak.txt", "hostile root");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Resolved-equivalence hooksPath (§4.7).
// ---------------------------------------------------------------------------

describe("hooksPath foreign-value checks compare resolved values (issue #68, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("a pre-set absolute equivalent spelling is a no-op naming the equivalence, and the run still verifies bound", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			// The live-clone ground: the same target under a different
			// spelling. On macOS the tmpdir path itself adds a symlinked
			// prefix (/var vs /private/var), so byte-equality would misread
			// this as foreign — the arm measures the normalization.
			const absoluteSpelling = join(fixture.root, ".githooks");
			gitOut(fixture.root, ["config", "core.hooksPath", absoluteSpelling]);
			requireInstrument(fixture.root);
			const run = runBind(fixture.root);
			assertBindSucceeded(run, "equivalent spelling");
			assert.match(
				run.output,
				/equivalen/i,
				`equivalent spelling: the no-op does not name the equivalence (wording pin): ${run.output}`,
			);
			assert.equal(
				gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				absoluteSpelling,
				"equivalent spelling: the instrument rewrote an equivalent value it owes a no-op (§4.7)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Exclusion at creation, both ways (AC4, §4.1).
// ---------------------------------------------------------------------------

/**
 * A clone whose committed tree carries `.githooks` (and optionally the
 * `.gitignore` anchor), plus one linked worktree — the shape whose `.git`
 * is a FILE, where the literal `.git/info/exclude` does not exist.
 */
function buildWorktreeSubstrate(withAnchor: boolean): { fixture: GithookFixture; wtRoot: string } {
	const fixture = buildGithookFixture({});
	if (withAnchor) {
		writeFileSync(join(fixture.root, ".gitignore"), "/.gitjig/\n");
		fixtureGit(fixture, ["add", "--", ".gitignore"]);
	}
	fixtureGit(fixture, ["add", "--", ".githooks"]);
	// --no-verify: substrate, never a measurement (fixture-builder doctrine).
	fixtureGit(fixture, ["commit", "--no-verify", "-q", "-m", "chore: seed the worktree checkout tree"]);
	const wtRoot = join(fixture.root, "zqworktree");
	fixtureGit(fixture, ["worktree", "add", "-q", "-b", "zqwtbranch", wtRoot]);
	mkdirSync(join(wtRoot, "home"));
	return { fixture, wtRoot };
}

describe("exclusion at creation, both ways (issue #68 AC4, SPEC §4.1)", { skip: IS_WINDOWS }, () => {
	it("with the .gitignore anchor present, the bind leaves info/exclude byte-identical", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			writeFileSync(join(fixture.root, ".gitignore"), "/.gitjig/\n");
			const excludeFile = resolvedExcludePath(fixture.root);
			const before = readOrNull(excludeFile);
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "anchor present");
			assert.deepEqual(
				readOrNull(excludeFile),
				before,
				"anchor present: the instrument wrote the fallback exclude although check-ignore already answers",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("without the anchor, the fallback writes the resolved info/exclude and check-ignore then answers", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "anchor absent");
			const check = spawnSync("git", ["check-ignore", "-q", "--", join(".gitjig", "state", AUDIT_FILE_NAME)], {
				cwd: fixture.root,
				env: constructedEnv(fixture.root),
				timeout: 30_000,
			});
			assert.equal(check.status, 0, "anchor absent: the record sink is not ignored after the bind");
			assert.equal(
				readFileSync(resolvedExcludePath(fixture.root), "utf8").includes(".gitjig"),
				true,
				"anchor absent: no .gitjig line in the resolved info/exclude",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("with no committed anchor, the exclusion fallback lands at the RESOLVED info/exclude — where .git is a gitfile", () => {
		const { fixture, wtRoot } = buildWorktreeSubstrate(false);
		try {
			requireInstrument(wtRoot);
			// Positive control for the shape: the worktree's .git is a FILE, so
			// the literal `.git/info/exclude` does not exist here and a
			// literal-path writer cannot have worked.
			assert.equal(
				lstatSync(join(wtRoot, ".git")).isFile(),
				true,
				"worktree substrate: .git is not a gitfile — the arm no longer measures the shape it names",
			);
			assertBindSucceeded(runBind(wtRoot), "worktree exclude fallback");
			const check = spawnSync("git", ["check-ignore", "-q", "--", join(".gitjig", "state", AUDIT_FILE_NAME)], {
				cwd: wtRoot,
				env: constructedEnv(wtRoot),
				timeout: 30_000,
			});
			assert.equal(check.status, 0, "worktree exclude fallback: the record sink is not ignored after the bind");
			const excludeFile = resolvedExcludePath(wtRoot);
			assert.equal(
				readFileSync(excludeFile, "utf8").includes(".gitjig"),
				true,
				`worktree exclude fallback: no .gitjig exclusion at the resolved ${excludeFile}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The exclusion fallback is a shell append at a path git resolves, so it
// carries the record writer's own hazard: a link at the leaf, or at the one
// directory component this instrument creates, sends the append somewhere
// the operator never named. The predicate is the sibling's, at
// `.githooks/_lib.sh`'s record writer — a link refusal at each component
// plus a regular-file test at the leaf. A MISSING exclude file still gets
// created and appended: that is the normal fallback, and refusing it would
// be a false block on the adopting-repository path this instrument serves.
// ---------------------------------------------------------------------------

describe("the exclusion fallback refuses to write through a link (issue #68 AC4, SPEC §5.5)", { skip: IS_WINDOWS }, () => {
	it("a symlinked info/exclude gains no append, and the run reports no bound state", () => {
		const fixture = buildGithookFixture({ unbound: true });
		const outside = mkdtempSync(join(tmpdir(), "gitjig-exclude-victim-"));
		try {
			requireInstrument(fixture.root);
			const victim = join(outside, "zqvictim.txt");
			const original = "zqoriginal victim content\n";
			writeFileSync(victim, original);
			const excludeFile = resolvedExcludePath(fixture.root);
			mkdirSync(dirname(excludeFile), { recursive: true });
			rmSync(excludeFile, { force: true });
			symlinkSync(victim, excludeFile);

			const run = runBind(fixture.root);
			assert.equal(
				readFileSync(victim, "utf8"),
				original,
				"linked info/exclude: the append landed on a file outside the repository, through the link " +
					"the writer never asked about (§5.5)",
			);
			assert.equal(
				lstatSync(excludeFile).isSymbolicLink(),
				true,
				"linked info/exclude: substrate — the link no longer stands, so the arm measured something else",
			);
			assert.notEqual(
				run.status,
				0,
				`linked info/exclude: the run reported success over a write it did not make\n${run.output}`,
			);
			assert.equal(
				/bound: verified/.test(run.output),
				false,
				`linked info/exclude: the success line was printed for a refused exclusion\n${run.output}`,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
			removeGithookFixture(fixture);
		}
	});

	it("a MISSING info/exclude is still created and appended — the refusal does not reach the normal fallback", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			const excludeFile = resolvedExcludePath(fixture.root);
			rmSync(excludeFile, { force: true });
			rmSync(dirname(excludeFile), { recursive: true, force: true });
			assertBindSucceeded(runBind(fixture.root), "absent info/exclude");
			assert.equal(
				readFileSync(excludeFile, "utf8").includes(".gitjig"),
				true,
				"absent info/exclude: the fallback did not create and append the exclusion — the guard above " +
					"turned the instrument's normal path into a false block",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Two spellings of the LOCAL `core.hooksPath` the read has to keep apart.
// An ABSENT key and one set to the empty string hand back the same empty
// value and different exit statuses, and only the status separates a fresh
// clone (activate) from a clone whose operator chose "run no hooks" (never
// overwrite, §4.7). And a `~/`-spelled value is one git expands and honours,
// so an equivalent spelling of the committed adapters must read as the
// equivalence it is, not as a foreign target.
// ---------------------------------------------------------------------------

describe("the local hooksPath read keeps empty apart from absent (issue #68 AC3, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("substrate: git itself separates the two by exit status alone", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			const read = (): { status: number | null; value: string } => {
				const result = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
					cwd: fixture.root,
					env: constructedEnv(fixture.root),
					timeout: 30_000,
				});
				return { status: result.status, value: (result.stdout ?? Buffer.alloc(0)).toString("utf8").trim() };
			};
			const absent = read();
			fixtureGit(fixture, ["config", "--local", "core.hooksPath", ""]);
			const empty = read();
			assert.deepEqual(
				[absent.value, empty.value],
				["", ""],
				"substrate: the two spellings no longer hand back the same value, so the arm below measures " +
					"a distinction the reader could have made from the value",
			);
			assert.equal(absent.status, 1, "substrate: an absent key no longer exits 1");
			assert.equal(empty.status, 0, "substrate: an explicitly empty value no longer exits 0");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("an explicitly empty local value is never overwritten, and survives the refused run byte-identical", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			fixtureGit(fixture, ["config", "--local", "core.hooksPath", ""]);
			const configPath = join(fixture.root, ".git", "config");
			const before = readFileSync(configPath);
			const run = runBind(fixture.root);
			assert.notEqual(
				run.status,
				0,
				`explicitly empty local value: the instrument reported a bound state over a setting it ` +
					`overwrote — a value this clone carries is its target's choice (§4.7)\n${run.output}`,
			);
			assert.deepEqual(
				readFileSync(configPath),
				before,
				"explicitly empty local value: the clone's own config is not byte-identical after the refused " +
					"run — the never-overwrite AC binds every value this clone carries, not only non-empty ones",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("an ABSENT local value still activates — the fresh-clone path this instrument exists for", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "absent local value");
			assert.equal(
				gitOut(fixture.root, ["config", "--local", "--get", "core.hooksPath"]),
				".githooks",
				"absent local value: the activation did not land, so the empty/absent discrimination was " +
					"bought with a false block on every fresh clone",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

describe("a ~/-spelled hooksPath is compared as git resolves it (issue #68 AC2, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("a tilde spelling of this clone's own adapters is an equivalent spelling, not a foreign target", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			// runBind and the fixture's git both take HOME=<root>/home, so the
			// tilde expands inside the fixture and nothing is planted on the host.
			symlinkSync(join(fixture.root, ".githooks"), join(fixture.root, "home", "zqequiv-githooks"));
			fixtureGit(fixture, ["config", "--local", "core.hooksPath", "~/zqequiv-githooks"]);

			const run = runBind(fixture.root);
			assertBindSucceeded(run, "tilde-spelled equivalent");
			assert.match(
				run.output,
				/equivalen/i,
				`tilde-spelled equivalent: the run did not name the equivalence — a spelling git expands to ` +
					`this clone's own adapters was read as a foreign target (§4.7)\n${run.output}`,
			);
			assert.equal(
				gitOut(fixture.root, ["config", "--local", "--get", "core.hooksPath"]),
				"~/zqequiv-githooks",
				"tilde-spelled equivalent: the no-op rewrote the operator's spelling",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the chain that spelling arms actually fires, which is what the verdict above claims", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);
			symlinkSync(join(fixture.root, ".githooks"), join(fixture.root, "home", "zqequiv-githooks"));
			fixtureGit(fixture, ["config", "--local", "core.hooksPath", "~/zqequiv-githooks"]);
			stageFile(fixture, "zqtildeleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the tilde-spelled chain\n");
			assertSecretRefused(attempt, "zqtildeleak.txt", "tilde-spelled chain");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Write-set measurement (AC4, §4.7 host boundary, §5.5).
// ---------------------------------------------------------------------------

describe("the instrument's write set is measured, not trusted (issue #68 AC4, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("writes ⊆ .git/config + resolved info/exclude; the shell's own namespace, HOME, global gitconfig and login files untouched", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			// The HOME sandbox sits INSIDE the fixture (runBind constructs
			// HOME=<root>/home), so a host-boundary violation lands inside the
			// snapshot instead of on the operator's real home.
			const homeFiles = [".gitconfig", ".bashrc", ".zshrc", ".profile"];
			for (const name of homeFiles) {
				writeFileSync(join(fixture.root, "home", name), `# zqhome ${name} untouched\n`);
			}
			const excludeRel = relative(fixture.root, resolvedExcludePath(fixture.root));
			// `.gitjig/**` is deliberately NOT allowed here: the arming run
			// writes no per-clone artifact at all, and the record writer is
			// what first materializes the namespace (§4.2).
			const allowed = (entry: string): boolean =>
				entry === ".git/config" || entry === excludeRel || entry === `${dirname(excludeRel)}/`;

			const sizeMap = (entries: string[]): Map<string, string> => {
				const map = new Map<string, string>();
				for (const entry of entries) {
					if (entry.endsWith("/")) {
						map.set(entry, "dir");
					} else {
						const cut = entry.lastIndexOf(" ");
						map.set(entry.slice(0, cut), entry.slice(cut + 1));
					}
				}
				return map;
			};

			const before = sizeMap(listTreeSizes(fixture.root));
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "write set");
			const after = sizeMap(listTreeSizes(fixture.root));

			const outside: string[] = [];
			for (const [name, size] of after) {
				if (before.get(name) !== size && !allowed(name)) {
					outside.push(name);
				}
			}
			for (const name of before.keys()) {
				if (!after.has(name) && !allowed(name)) {
					outside.push(`${name} (removed)`);
				}
			}
			assert.deepEqual(
				outside,
				[],
				"write set: the bind touched entries outside .git/config + the resolved info/exclude (§4.7)",
			);
			for (const name of homeFiles) {
				assert.equal(
					readFileSync(join(fixture.root, "home", name), "utf8"),
					`# zqhome ${name} untouched\n`,
					`write set: the sandboxed HOME file ${name} was rewritten (§4.7 forbids the category)`,
				);
			}
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Root-only binding (§4.7).
// ---------------------------------------------------------------------------

describe("binding is root-only, never recursive (issue #68, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("invoked from a subdirectory, the activation lands at the repository root and a nested repository stays untouched", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			mkdirSync(join(fixture.root, "zqsubdir"));
			const nested = join(fixture.root, "zqnested");
			mkdirSync(nested);
			mkdirSync(join(nested, "home"));
			gitOut(nested, ["init", "-q"]);
			const nestedConfigBefore = readFileSync(join(nested, ".git", "config"));

			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root, [], { cwd: join(fixture.root, "zqsubdir") }), "root-only");
			assert.equal(
				localConfig(fixture.root, "core.hooksPath"),
				".githooks",
				"root-only: the repository root's own config never received the activation",
			);
			assert.equal(
				existsSync(join(fixture.root, "zqsubdir", ".git")),
				false,
				"root-only: a git directory appeared at the invoking subdirectory",
			);
			assert.equal(
				localConfig(nested, "core.hooksPath"),
				"",
				"root-only: the nested repository was armed (§4.7 root-only)",
			);
			assert.deepEqual(
				readFileSync(join(nested, ".git", "config")),
				nestedConfigBefore,
				"root-only: the nested repository's config was touched (§4.7 root-only)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The record writer's own bounds (§5.5), driven at the committed runtime the
// adapters source.
// ---------------------------------------------------------------------------

describe("the tier's record writer bounds its own writes (issue #68, SPEC §5.5)", { skip: IS_WINDOWS }, () => {
	it("hostile audit_log arguments land exactly one sanitized, non-forging JSON line (§5.5, §3.8)", () => {
		const fixture = buildGithookFixture({});
		try {
			const sink = opSink(fixture.root);
			const before = existsSync(sink) ? readFileSync(sink, "utf8") : "";
			// Newline + a full record-shaped forgery + backslash + a control
			// byte + a quote, all from codepoints (header note).
			const hostile =
				"zqhosthead" +
				cp(0x0a) +
				"{" + cp(0x22) + "action" + cp(0x22) + ":" + cp(0x22) + "zqforgedrec" + cp(0x22) + "}" +
				cp(0x0a) +
				cp(0x5c) +
				cp(0x01) +
				cp(0x22) +
				"zqhosttail";
			const call = spawnSync(
				"bash",
				["-c", '. "$1" && audit_log warn secret "$2"', "bash", join(fixture.root, LIB_REL), hostile],
				{ cwd: fixture.root, env: constructedEnv(fixture.root), timeout: 30_000 },
			);
			assert.equal(call.status, 0, `hostile args: the audit_log call failed: ${call.stderr?.toString("utf8")}`);
			const after = readFileSync(sink, "utf8");
			const delta = after.slice(before.length);
			const lines = delta.split("\n").filter((line) => line !== "");
			assert.equal(
				lines.length,
				1,
				`hostile args: expected exactly ONE appended line — a raw newline in the argument split or ` +
					`forged a record; delta: ${JSON.stringify(delta)}`,
			);
			assert.doesNotThrow(
				() => JSON.parse(lines[0]),
				`hostile args: the appended line is not one well-formed JSON record: ${JSON.stringify(lines[0])}`,
			);
			assert.equal(
				Buffer.from(delta, "utf8").includes(0x01),
				false,
				"hostile args: a raw control byte reached the record (the sanitizer must strip control bytes)",
			);
			assert.equal(
				lines[0].includes("zqhosthead") && lines[0].includes("zqhosttail"),
				true,
				`hostile args: the sanitized record dropped the argument's printable content: ${JSON.stringify(lines[0])}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the record writer mints its sink owner-only and its namespace traversable, whatever the ambient umask", () => {
		// §5.5 binds state at rest to the account that writes it, and this
		// writer is ordinarily the first to materialize the shell's namespace
		// on a clone that has never recorded anything — so the modes minted
		// here are the modes the namespace keeps. The ambient umask is opened
		// wide on the child, which is the direction that has to be pinned: a
		// mode passed at creation is a CEILING under a umask, so a run under
		// `umask 000` is where a missing ceiling shows.
		const fixture = buildGithookFixture({});
		try {
			const sink = opSink(fixture.root);
			const call = spawnSync(
				"bash",
				["-c", 'umask 000; . "$1" && audit_log warn secret zqmodeprobe', "bash", join(fixture.root, LIB_REL)],
				{ cwd: fixture.root, env: constructedEnv(fixture.root), timeout: 30_000 },
			);
			assert.equal(call.status, 0, `sink mode: the audit_log call failed: ${call.stderr?.toString("utf8")}`);
			assert.equal(
				existsSync(sink),
				true,
				"positive control: no sink was created, so every mode claim below would hold vacuously",
			);
			assert.equal(
				(statSync(sink).mode & 0o777).toString(8),
				"600",
				"the record sink is readable by accounts other than the one that wrote it — an audit record " +
					"names what a repository's work touched, and a host may carry accounts that work never " +
					"concerned (§5.5)",
			);
			for (const created of [join(fixture.root, ".gitjig"), join(fixture.root, ".gitjig", "state")]) {
				assert.equal(
					(statSync(created).mode & 0o777).toString(8),
					"700",
					`${created} was created under the ambient umask — every directory of the shell's own ` +
						`namespace is owner-only at creation, and it must keep its owner search bit or every ` +
						`later append and read is silently lost (§5.5)`,
				);
			}
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("concurrent bash and Node appends interleave by whole lines only, at a record size inside the single-append bound (mixed-writer sink bound)", async () => {
		const fixture = buildGithookFixture({});
		try {
			const stateRoot = join(fixture.root, ".gitjig", "state");
			mkdirSync(stateRoot, { recursive: true });
			const sink = opSink(fixture.root);
			const linesBefore = existsSync(sink)
				? readFileSync(sink, "utf8").split("\n").filter((line) => line !== "").length
				: 0;

			const bashScript = '. "$1"\nfor i in $(seq 1 25); do audit_log warn secret "zqbashwriter $i"; done';
			const children = [1, 2, 3, 4].map(() =>
				spawn("bash", ["-c", bashScript, "bash", join(fixture.root, LIB_REL)], {
					cwd: fixture.root,
					env: constructedEnv(fixture.root),
				}),
			);
			let nodeOk = true;
			for (let i = 0; i < 40; i += 1) {
				nodeOk =
					appendAuditRecord(stateRoot, { category: "secret", action: "warn", text: `zqnodewriter ${i}` }) &&
					nodeOk;
			}
			await Promise.all(
				children.map(
					(child) =>
						new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => {
								child.kill("SIGKILL");
								reject(new Error("mixed writers: a bash writer hung (timeout wrap)"));
							}, 30_000);
							child.on("close", (code) => {
								clearTimeout(timer);
								if (code === 0) {
									resolve();
								} else {
									reject(new Error(`mixed writers: a bash writer exited ${code}`));
								}
							});
						}),
				),
			);
			assert.equal(nodeOk, true, "mixed writers: a Node append degraded open — the sink under test is dead");

			const lines = readFileSync(sink, "utf8").split("\n").filter((line) => line !== "");
			assert.equal(
				lines.length,
				linesBefore + 140,
				`mixed writers: line count != write count — a torn append merged or split records; ` +
					`got ${lines.length}, expected ${linesBefore + 140}. This arm's records sit inside the ` +
					`single-append size bound; raise the text past it and a torn line is the residual ` +
					`.githooks/_lib.sh's audit_log header states, not a regression`,
			);
			assert.equal(
				lines.filter((line) => line.includes("zqbashwriter")).length,
				100,
				"mixed writers: bash-authored record count drifted",
			);
			assert.equal(
				lines.filter((line) => line.includes("zqnodewriter")).length,
				40,
				"mixed writers: Node-authored record count drifted",
			);
			for (const line of lines) {
				assert.doesNotThrow(
					() => JSON.parse(line),
					`mixed writers: an interleaved line is not one well-formed record: ${JSON.stringify(line)}`,
				);
			}
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// A sourced file's own `exit`, nested (§3.2 fold direction).
// ---------------------------------------------------------------------------

describe("a sourced file's own `exit` folds the hook to allow (issue #68, SPEC §3.2)", { skip: IS_WINDOWS }, () => {
	/** The control the arm below owes: this fixture's chain provably refuses. */
	function assertFixtureArmed(fixture: GithookFixture, marker: string, arm: string): void {
		stageFile(fixture, marker, AWS_SECRET + "\n");
		const control = commitWithMessage(fixture, "chore: exercise the fixture-arming control\n");
		assertSecretRefused(control, marker, `${arm} control`);
		fixtureGit(fixture, ["reset", "-q", "--", marker]);
		rmSync(join(fixture.root, marker), { force: true });
	}

	it("NESTED source: a helper that itself calls githook_source and then exits still folds, and does not wedge git", () => {
		const fixture = buildArmedScanFixture();
		try {
			assertFixtureArmed(fixture, "zqnestedctl.txt", "nested source");

			// The inner call's own window closes FIRST. If closing it cleared the
			// trap, the outer helper's `exit` below would leave the hook carrying
			// status 9 to git with nothing printed — a wedged commit whose only
			// recovery is --no-verify, the one direction this tier never takes.
			appendFileSync(
				join(fixture.root, ".githooks", "helpers", "secret_scan.sh"),
				"\ngithook_source conventional_commit.sh commit-format\nexit 9\n",
			);

			stageFile(fixture, "zqnestedleak.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the nested-source arm\n");
			assert.equal(
				attempt.status,
				0,
				`nested source: the commit was refused — an inner githook_source closed the window that was ` +
					`folding the OUTER source, so the helper's exit status reached git; stderr: ` +
					`${JSON.stringify(attempt.stderr)}`,
			);
			assert.match(
				attempt.stderr,
				/not enforced: a helper did not finish sourcing/,
				`nested source: the fold left no notice at all — the operator gets an allow that enforced ` +
					`nothing and no surface says so (§3.9); stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The fold's arming record is reachable from the files it guards (issue #71).
// A sourced file executes in the hook's OWN shell, so the bookkeeping the fold
// consults is addressable by the very code whose failure it exists to catch.
// Both arms below corrupt it with ONE appended line in a committed helper, and
// each measures the fold's own contract rather than the corruption: the tier
// never carries a helper's status to git (§3.2, §5.2), and a run in which every
// source completed never records one that did not.
// ---------------------------------------------------------------------------

describe("the source fold's arming record is unreachable from a sourced file (issue #71, SPEC §3.2, §5.2)", { skip: IS_WINDOWS }, () => {
	it("a helper that UNSETS the arming record leaves the NEXT source window unguarded", () => {
		const fixture = buildArmedScanFixture();
		try {
			// `pre-commit` sources branch_guard.sh first and secret_scan.sh second.
			// Clearing the record inside the first source makes the decrement land
			// below zero, so the second window's arming test never matches and the
			// window opens with no trap behind it.
			appendFileSync(join(fixture.root, ".githooks", "helpers", "branch_guard.sh"), "\nunset _GH_SRC_DEPTH\n");
			// The failure the fold exists to absorb, in the now-unguarded window.
			appendFileSync(join(fixture.root, ".githooks", "helpers", "secret_scan.sh"), "\nexit 9\n");

			const attempt = commitWithMessage(fixture, "chore: exercise the unset-arming-record arm\n");
			assert.equal(
				attempt.status,
				0,
				`unset arming record: the commit was refused on machinery the actor did not cause — the one ` +
					`direction §5.2 states this tier never takes; status ${attempt.status}, stderr: ` +
					`${JSON.stringify(attempt.stderr)}`,
			);
			assert.match(
				attempt.stderr,
				/not enforced: a helper did not finish sourcing/,
				`unset arming record: the fold left no notice, so the operator cannot tell a disarmed allow from ` +
					`an enforced one (§3.9); stderr: ${JSON.stringify(attempt.stderr)}`,
			);
			assert.match(
				attempt.auditDelta,
				/source-incomplete/,
				`unset arming record: the fold left no record either, so nothing durable says the tier ran none ` +
					`of its remaining checks (§3.9, §5.5); auditDelta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a helper that RAISES the arming record leaves the trap armed past the sourcing function", () => {
		const fixture = buildArmedScanFixture();
		try {
			// `commit-msg` sources conventional_commit.sh. Raising the record inside
			// that source leaves the decrement above zero, so the window is never
			// closed and the EXIT trap outlives the function that armed it — firing
			// at the adapter's own exit, where its `exit 0` overwrites the refusal.
			appendFileSync(
				join(fixture.root, ".githooks", "helpers", "conventional_commit.sh"),
				"\n_GH_SRC_DEPTH=$(( ${_GH_SRC_DEPTH:-0} + 1 ))\n",
			);

			const attempt = commitWithMessage(fixture, "no type here, just prose\n");
			assert.notEqual(
				attempt.status,
				0,
				`raised arming record: the commit was CREATED while the grammar refusal stood in the record ` +
					`sink — the artifact says allowed and the trail says blocked; auditDelta: ` +
					`${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.doesNotMatch(
				attempt.auditDelta,
				/source-incomplete/,
				`raised arming record: every source in this run completed, yet the trail names one that did not ` +
					`finish — a record of a failure that never happened; auditDelta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Sink hardening the sibling suite's link arms do not reach (§4.6, §5.5).
// ---------------------------------------------------------------------------

describe("the derived sink stays writable and refuses an object it did not create (issue #68, SPEC §4.6, §5.5)", { skip: IS_WINDOWS }, () => {
	it("a refusal after .gitjig/state is removed re-creates a traversable dir and lands the block record", () => {
		const fixture = buildArmedScanFixture();
		try {
			stageFile(fixture, "zqumaskseed.txt", AWS_SECRET + "\n");
			commitWithMessage(fixture, "chore: seed the state directory\n");
			fixtureGit(fixture, ["reset", "-q", "--", "zqumaskseed.txt"]);
			rmSync(join(fixture.root, "zqumaskseed.txt"), { force: true });
			rmSync(join(fixture.root, ".gitjig", "state"), { recursive: true, force: true });

			stageFile(fixture, "zqumaskleak.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the state-dir umask arm\n");
			assert.notEqual(attempt.status, 0, "state-dir umask: the staged secret passed — the armed chain did not fire");
			assert.doesNotThrow(
				() => accessSync(join(fixture.root, ".gitjig", "state"), constants.X_OK),
				"state-dir umask: the re-created .gitjig/state has no search bit — a directory created under " +
					"the file-append umask silently loses every subsequent append and read (§4.6)",
			);
			assert.match(
				attempt.auditDelta,
				/\bblock\b.*\bsecret\b/,
				`state-dir umask: the refusal's block record never reached the derived sink — the append ` +
					`into the recreated dir was swallowed; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a bare FIFO at the sink refuses the record instead of parking the commit", () => {
		// The sibling suite's link arms all plant a SYMLINK, and the writer's
		// guard asks exactly that question (`[ -L ]`). A FIFO is not a link and
		// not a regular file: it passes every guard and reaches the append,
		// where an open on a reader-less FIFO blocks — inside a pre-commit
		// hook, that is `git commit` parked with no bound to reap it. The guard
		// has to decide on the object's TYPE. Enforcement survives the refusal:
		// the commit is still refused, only the record it can no longer write
		// is lost.
		const fixture = buildArmedScanFixture();
		const sink = opSink(fixture.root);
		try {
			mkdirSync(dirname(sink), { recursive: true });
			const made = spawnSync("mkfifo", [sink], { timeout: 30_000 });
			assert.equal(made.status, 0, `substrate: mkfifo at the sink failed: ${made.stderr?.toString("utf8")}`);
			stageFile(fixture, "zqfifoleak.txt", AWS_SECRET + "\n");
			const status = commitTimed(fixture, "chore: exercise the fifo-sink arm", 20_000);
			assert.notEqual(
				status,
				null,
				"fifo sink: the commit never returned — the record append parked on the reader-less FIFO, so " +
					"a plain `git commit` hangs forever on any clone where one is planted at the sink (§4.6)",
			);
			assert.notEqual(status, 0, "fifo sink: the staged secret passed — the armed chain did not fire");
			assert.equal(
				lstatSync(sink).isFIFO(),
				true,
				"fifo sink: the planted FIFO is gone — the writer replaced another writer's object instead of " +
					"refusing it (§5.5)",
			);
		} finally {
			unparkFifo(sink);
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Hostile-environment scrub (#39).
// ---------------------------------------------------------------------------

describe("a hostile git environment cannot retarget the bind (issue #68, #39 constructed environment)", { skip: IS_WINDOWS }, () => {
	it("the cwd repository binds normally and the env-named repository is untouched", () => {
		const fixture = buildGithookFixture({ unbound: true });
		const other = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			const otherConfigBefore = readFileSync(join(other.root, ".git", "config"));
			const run = runBind(fixture.root, [], {
				env: { GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root },
			});
			assertBindSucceeded(run, "env scrub");
			assert.equal(
				localConfig(fixture.root, "core.hooksPath"),
				".githooks",
				"env scrub: the cwd repository never received the activation — the hostile env retargeted the bind",
			);
			assert.equal(
				localConfig(other.root, "core.hooksPath"),
				"",
				"env scrub: the OTHER repository was armed through the hostile GIT_DIR",
			);
			assert.deepEqual(
				readFileSync(join(other.root, ".git", "config")),
				otherConfigBefore,
				"env scrub: the other repository's config was rewritten through the hostile GIT_DIR",
			);
		} finally {
			removeGithookFixture(fixture);
			removeGithookFixture(other);
		}
	});

	it("a hostile GIT_CONFIG neither escapes the write set nor fakes verification", () => {
		// An inherited GIT_CONFIG retargets every `git config` child: without
		// the scrub, the persistent hooksPath write lands in the pointed-at
		// file OUTSIDE the repository, the clone's own config stays empty
		// (the tier is dead), and verification reads the fabricated answer
		// back as a verified bound state.
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			const victim = join(fixture.root, "zqgitcfgvictim.cfg");
			writeFileSync(victim, "# zqvictimcfg\n");
			const run = runBind(fixture.root, [], { env: { GIT_CONFIG: victim } });
			assertBindSucceeded(run, "GIT_CONFIG scrub");
			assert.equal(
				readFileSync(victim, "utf8"),
				"# zqvictimcfg\n",
				"GIT_CONFIG scrub: the hooksPath write escaped the repository into the pointed-at file (§4.7's write set)",
			);
			assert.equal(
				localConfig(fixture.root, "core.hooksPath"),
				".githooks",
				"GIT_CONFIG scrub: the clone's own config never received the activation — the reported bound " +
					"state was fabricated by the retargeted reads",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("hostile GIT_TRACE/GIT_TRACE2_EVENT targets receive nothing", () => {
		// The retargeting family above is not the whole class: git's trace
		// family makes a child CREATE OR APPEND a file at a path the
		// environment names, which escapes §4.7's write set.
		// GIT_TRACE2_EVENT is pointed at the victim DIRECTORY (git drops
		// per-process event files inside a directory target) and GIT_TRACE at
		// a file path inside it, so both the "no new entry" and the "seeded
		// bytes intact" shapes are measured at once.
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			const victimDir = join(fixture.root, "zqtracevictim");
			mkdirSync(victimDir);
			const seeded = join(victimDir, "zqtraceseed.txt");
			writeFileSync(seeded, "# zqtracebytes\n");
			const traceEnv = {
				GIT_TRACE: join(victimDir, "zqtrace.log"),
				GIT_TRACE2: join(victimDir, "zqtrace2.log"),
				GIT_TRACE2_EVENT: victimDir,
				GIT_TRACE2_PERF: join(victimDir, "zqtrace2perf.log"),
				GIT_TRACE_SETUP: join(victimDir, "zqtracesetup.log"),
				GIT_TRACE_PACKET: join(victimDir, "zqtracepacket.log"),
				GIT_TRACE_PERFORMANCE: join(victimDir, "zqtraceperf.log"),
				GIT_TRACE_CURL: join(victimDir, "zqtracecurl.log"),
			};
			assertBindSucceeded(runBind(fixture.root, [], { env: traceEnv }), "trace scrub");
			assert.deepEqual(
				listTreeEntries(victimDir),
				["zqtraceseed.txt"],
				"trace scrub: a git child created a file at the environment-named trace target — the bind's " +
					"write set escaped the repository (§4.7)",
			);
			assert.equal(
				readFileSync(seeded, "utf8"),
				"# zqtracebytes\n",
				"trace scrub: the seeded victim file was appended to through a trace target",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Scope split: the activation and its verification decide on LOCAL scope,
// with the ambient scopes neither standing in nor blocking (§4.7).
// ---------------------------------------------------------------------------

describe("activation and verification decide on LOCAL scope (issue #68, SPEC §4.7)", { skip: IS_WINDOWS }, () => {
	it("a global-origin EQUIVALENT value still writes the per-clone activation, and verification reads it", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			// The consumer's own config resolution sees this value; the clone
			// itself carries nothing, so the same clone in any other
			// environment has no hooks path at all. A no-op here would report a
			// verified bound state that exists only in this HOME.
			const gitconfig = join(fixture.root, "home", ".gitconfig");
			writeFileSync(gitconfig, `[core]\n\thooksPath = ${join(fixture.root, ".githooks")}\n`);
			const globalBefore = readFileSync(gitconfig);
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "global-origin equivalent");
			assert.equal(
				localConfig(fixture.root, "core.hooksPath"),
				".githooks",
				"global-origin equivalent: the clone's OWN config never received the activation — the run " +
					"reported a verified bound state that holds only inside this environment's global config",
			);
			assert.deepEqual(
				readFileSync(gitconfig),
				globalBefore,
				"global-origin equivalent: the instrument wrote the global gitconfig (§4.7 host boundary)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a global-origin FOREIGN value does not refuse the bind: the local activation is written and wins", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			// An ambient hooks path this repository did not choose. Refusing
			// here would leave the advisory naming a re-arm command that can
			// never discharge.
			const other = join(fixture.root, "zqglobalhooks");
			mkdirSync(other);
			const gitconfig = join(fixture.root, "home", ".gitconfig");
			writeFileSync(gitconfig, `[core]\n\thooksPath = ${other}\n`);
			const globalBefore = readFileSync(gitconfig);
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "global-origin foreign");
			assert.equal(
				localConfig(fixture.root, "core.hooksPath"),
				".githooks",
				"global-origin foreign: no per-clone activation was written — target's-choice-wins applies to " +
					"a value THIS clone carries, not to an ambient one the clone can override",
			);
			assert.equal(
				gitOut(fixture.root, ["config", "--get", "core.hooksPath"]),
				".githooks",
				"global-origin foreign: the effective value is still the foreign one — the local activation " +
					"must take precedence over the global scope",
			);
			assert.deepEqual(
				readFileSync(gitconfig),
				globalBefore,
				"global-origin foreign: the instrument rewrote the global gitconfig instead of the clone's own (§4.7)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The verdict the success line claims: `bound: verified` says the tier is
// ARMED for this worktree, so the shapes that pass a path comparison while
// arming nothing are refused here — a directory that resolves outside the
// repository, and adapter files that are absent, empty, or not executable by
// this account, none of which put a check in front of a commit. Each arm
// opens with a same-run positive control: the unmutated fixture binds, so a
// refusal below is the mutation and not a dead substrate.
// ---------------------------------------------------------------------------

describe("the arming verdict is refused where the adapters would not run (issue #68, SPEC §3.2, §5.2)", { skip: IS_WINDOWS }, () => {
	it("a .githooks directory carrying no adapters does not report a verified bound state", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "adapters-present control");
			for (const adapter of ["pre-commit", "pre-push", "commit-msg"]) {
				rmSync(join(fixture.root, ".githooks", adapter), { force: true });
			}
			const run = runBind(fixture.root);
			assert.notEqual(
				run.status,
				0,
				`emptied adapters: the instrument reported a verified bound state for a hooks directory git ` +
					`would run nothing from — the operator asked whether the tier is armed and was told yes ` +
					`while every arm is dead\n${run.output}`,
			);
			assert.equal(
				/pre-commit/.test(run.output),
				true,
				`emptied adapters: the refusal names no missing adapter, so the operator cannot act on it\n${run.output}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	/**
	 * Two shapes a presence probe passes and git arms nothing from: an
	 * adapter emptied in place with its exec bit intact (git runs it, and it
	 * decides nothing), and one that lost its exec bit (git skips it). Both
	 * defeat every arm of the tier at once while the operator's own
	 * "is it armed?" command answers yes, so each is measured through a
	 * `git commit` in the same fixture as well as through the verdict.
	 */
	for (const shape of [
		{
			label: "emptied in place, exec bit intact",
			marker: "zqemptied",
			mutate(root: string): void {
				for (const adapter of ["pre-commit", "pre-push", "commit-msg"]) {
					writeFileSync(join(root, ".githooks", adapter), "");
				}
			},
		},
		{
			label: "present but not executable",
			marker: "zqnoexec",
			mutate(root: string): void {
				for (const adapter of ["pre-commit", "pre-push", "commit-msg"]) {
					chmodSync(join(root, ".githooks", adapter), 0o644);
				}
			},
		},
	] as const) {
		it(`adapters ${shape.label} do not report a verified bound state`, () => {
			const fixture = buildGithookFixture({ unbound: true });
			try {
				requireInstrument(fixture.root);
				assertBindSucceeded(runBind(fixture.root), `${shape.marker} control`);
				shape.mutate(fixture.root);
				const run = runBind(fixture.root);
				assert.notEqual(
					run.status,
					0,
					`${shape.label}: the instrument reported a verified bound state for adapters that arm ` +
						`nothing — the operator asked whether the tier is armed and was told yes while every ` +
						`arm is dead\n${run.output}`,
				);
				assert.equal(
					/pre-commit/.test(run.output),
					true,
					`${shape.label}: the refusal names no adapter, so the operator cannot act on it\n${run.output}`,
				);
			} finally {
				removeGithookFixture(fixture);
			}
		});

		it(`adapters ${shape.label} let a staged secret through, which is what the verdict above predicts`, () => {
			const fixture = buildArmedScanFixture();
			try {
				const marker = `${shape.marker}ctl.txt`;
				stageFile(fixture, marker, `${AWS_SECRET}\n`);
				const control = commitWithMessage(fixture, "chore: exercise the arming control\n");
				assertSecretRefused(control, marker, `${shape.label} control`);
				fixtureGit(fixture, ["reset", "-q", "--", marker]);
				rmSync(join(fixture.root, marker), { force: true });
				shape.mutate(fixture.root);
				const leak = `${shape.marker}leak.txt`;
				stageFile(fixture, leak, `${AWS_SECRET}\n`);
				const attempt = commitWithMessage(fixture, "no format at all\n");
				assert.equal(
					attempt.status,
					0,
					`${shape.label}: substrate — the mutated chain still refused, so the verdict arm above ` +
						`would be answering about a live tier; stderr: ${JSON.stringify(attempt.stderr)}`,
				);
			} finally {
				removeGithookFixture(fixture);
			}
		});
	}

	it("a .githooks directory that resolves outside the repository does not report a verified bound state", () => {
		const fixture = buildGithookFixture({ unbound: true });
		const outside = mkdtempSync(join(tmpdir(), "gitjig-escaped-hooks-"));
		try {
			requireInstrument(fixture.root);
			assertBindSucceeded(runBind(fixture.root), "in-repository control");
			cpSync(join(fixture.root, ".githooks"), join(outside, "githooks"), { recursive: true });
			rmSync(join(fixture.root, ".githooks"), { recursive: true, force: true });
			symlinkSync(join(outside, "githooks"), join(fixture.root, ".githooks"));
			const run = runBind(fixture.root);
			assert.notEqual(
				run.status,
				0,
				`escaping hooks link: the instrument reported a verified bound state for a hooks directory ` +
					`outside the repository — the runtime refuses that chain on every commit, so the arming ` +
					`verdict and the runtime it predicts disagree\n${run.output}`,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
			removeGithookFixture(fixture);
		}
	});

	it("a foreign hooks path reaches the terminal with its control bytes removed (issue #47)", () => {
		const fixture = buildGithookFixture({ unbound: true });
		try {
			requireInstrument(fixture.root);
			const hostile = `${join(fixture.root, "zqevil")}${cp(0x1b)}[31mZQRED${cp(0x1b)}]0;zqpwned${cp(0x07)} end`;
			gitOut(fixture.root, ["config", "extensions.worktreeConfig", "true"]);
			gitOut(fixture.root, ["config", "--worktree", "core.hooksPath", hostile]);
			const run = runBind(fixture.root);
			assert.notEqual(run.status, 0, `hostile hooksPath: the run did not refuse, so no message is measured\n${run.output}`);
			assert.equal(
				run.output.includes("ZQRED"),
				true,
				`hostile hooksPath: the refusal does not carry the value at all, so the byte-absence assertion ` +
					`below would pass vacuously\n${JSON.stringify(run.output)}`,
			);
			for (const [name, byte] of [
				["ESC", cp(0x1b)],
				["BEL", cp(0x07)],
			] as const) {
				assert.equal(
					run.output.includes(byte),
					false,
					`hostile hooksPath: a ${name} byte from a git-supplied value reached the operator's terminal ` +
						`raw — the record writer strips it and this surface must too\n${JSON.stringify(run.output)}`,
				);
			}
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
