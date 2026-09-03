/**
 * Behavioral suite for the local tier that DERIVES its own locations
 * (issue #68 amended ACs; SPEC §3.2 derivation + arm-ordered fold + push
 * stdin discipline, §4.1 helper home is also how helpers are found, §4.2
 * no generated code beside the committed bytes, §4.6 one derivation both
 * sides perform, §5.2 fold-to-allow signals, §5.5 record writer).
 *
 * Subject under test: the fixture's byte-verified copy of THIS repository's
 * `.githooks/` tree, activated the only way a clone activates it —
 * `core.hooksPath` — and measured through `git commit` / `git push`, never
 * a predicate called directly. Nothing is written at `.ghjig/` by the
 * fixture: the tier resolves its helper directory from the running file's
 * own installed position and its record sink from the repository top, so a
 * clone that has activated the hooks path is fully armed.
 *
 * FIXTURE DISCIPLINE (three traps, each measured on this change):
 *   - the WHOLE `.githooks` tree is copied by `buildGithookFixture`, which
 *     byte-verifies the copy: copying `helpers/*.sh` alone drops the
 *     extensionless `helpers/secret-patterns`, the scan silently disarms,
 *     and every "allow" measured against it means nothing;
 *   - every arm that asserts an ALLOW opens with `assertFixtureArmed` on
 *     the same fixture, which proves that fixture refuses a staged
 *     pattern-matching key before the arm's mutation lands;
 *   - the fixture mints its own state. No arm reads this clone's own
 *     `.ghjig/` — that is a foreign file, not one the tier authored.
 *
 * Environment constraints (sibling-suite doctrine, stated in place):
 *   - every secret fragment is BUILT FROM CODEPOINTS, never literal, so
 *     this source cannot trip the shell's own staged-secret matcher and
 *     byte-absence assertions stay honest;
 *   - distinctive `zq…` markers wherever a byte-presence or byte-absence
 *     assertion runs, so incidental git output cannot collide;
 *   - every spawn is timeout-wrapped; POSIX substrate only (skips win32).
 *
 * PINNED SPELLINGS (the wording contract this suite and the tier share):
 *   - a fail-open fold says `not enforced` plainly (SPEC §3.9's
 *     degradation-signal rule; §4.5's inventory sentence);
 *   - a refusal names the matched pattern's ID (`aws-access-key-id`) and
 *     never the matched bytes (§3.3, §3.8).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	pushRefs,
	removeGithookFixture,
	seedLocalCommit,
} from "./harness/githook-fixture.ts";
import { AUDIT_FILE_NAME, listTreeEntries, listTreeSizes, repoRoot } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";
const cp = String.fromCharCode;

/** Distinctive branch names (header note). */
const PROTECTED = "zqderivedtrunkzq";
const FEATURE = "zqderivedfeatzq";

/** "AKIA" — assembled from codepoints, never literal in this source. */
const AKIA = cp(0x41, 0x4b, 0x49, 0x41);
/** The canonical documentation key: AKIA + 16 × [A-Z0-9]. */
const AWS_SECRET = AKIA + "IOSFODNN7EXAMPLE";
const AWS_PATTERN_ID = "aws-access-key-id";

/** The retired per-clone binding path — a file the tier no longer reads. */
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

function opSink(root: string): string {
	return join(root, ".ghjig", "state", AUDIT_FILE_NAME);
}

function helperPath(root: string, name: string): string {
	return join(root, ".githooks", "helpers", name);
}

/**
 * A clone armed the only way the derived tier is armed: the committed
 * `.githooks/` tree at its committed relative path and `core.hooksPath`
 * naming it. NOTHING is written under `.ghjig/` — a fixture that supplied
 * a per-clone binding would be measuring the binding, not the derivation.
 */
function buildDerivedFixture(): GithookFixture {
	const fixture = buildGithookFixture({ unbound: true, remote: { defaultBranch: PROTECTED } });
	fixtureGit(fixture, ["config", "core.hooksPath", ".githooks"]);
	fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);
	return fixture;
}

/** Write + stage one worktree file (setup substrate). */
function stageFile(fixture: GithookFixture, name: string, content: string | Buffer): void {
	writeFileSync(join(fixture.root, name), content);
	fixtureGit(fixture, ["add", "--", name]);
}

/**
 * The armed-refusal observable on the DERIVED sink (§3.3, §4.6): a block
 * record naming the secret class, the pattern ID on both refusal surfaces,
 * a non-zero commit, and the secret's own bytes on no surface at all.
 */
function assertSecretRefused(attempt: CommitAttempt, stagedPath: string, arm: string): void {
	assert.notEqual(
		attempt.status,
		0,
		`${arm}: the guarded commit succeeded — the chain the activated hooks path arms did not refuse; ` +
			`stderr: ${JSON.stringify(attempt.stderr)}`,
	);
	assert.equal(
		attempt.stderr.includes(AWS_PATTERN_ID),
		true,
		`${arm}: the refusal's stderr does not name pattern '${AWS_PATTERN_ID}' (§3.3): ` +
			`${JSON.stringify(attempt.stderr)}`,
	);
	assert.match(
		attempt.auditDelta,
		/\bblock\b.*\bsecret\b/,
		`${arm}: no block record naming the secret class reached the derived sink at ` +
			`.ghjig/state/${AUDIT_FILE_NAME} (§4.6 writer path = reader path); ` +
			`delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.equal(
		attempt.auditDelta.includes(AWS_PATTERN_ID),
		true,
		`${arm}: the record does not name pattern '${AWS_PATTERN_ID}' (§3.3): ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.equal(
		attempt.auditDelta.includes(stagedPath),
		true,
		`${arm}: the record does not name the offending path (§3.11's dead-recovery rule — a record that ` +
			`omits the object leaves the operator no place to act): ${JSON.stringify(attempt.auditDelta)}`,
	);
	for (const [surface, bytes] of [
		["stderr", attempt.stderrBytes],
		["stdout", attempt.stdoutBytes],
		["the record delta", Buffer.from(attempt.auditDelta, "utf8")],
	] as const) {
		assert.equal(
			bytes.includes(Buffer.from(AWS_SECRET, "utf8")),
			false,
			`${arm}: the planted key's bytes reached ${surface} (§3.8's refusal-record rule)`,
		);
	}
}

/**
 * The control every allow-asserting arm owes (header note): THIS fixture
 * refuses a staged pattern-matching key before the arm's mutation lands. An
 * allow measured on a chain that never fired measures the fixture, not the
 * tier.
 */
function assertFixtureArmed(fixture: GithookFixture, marker: string, arm: string): void {
	stageFile(fixture, marker, `${AWS_SECRET}\n`);
	const control = commitWithMessage(fixture, "chore: exercise the fixture-arming control\n");
	assertSecretRefused(control, marker, `${arm} control`);
	fixtureGit(fixture, ["reset", "-q", "--", marker]);
	rmSync(join(fixture.root, marker), { force: true });
}

/** Every stderr line announcing a fail-open fold (§3.9's pinned spelling). */
function notEnforcedLines(attempt: CommitAttempt): string[] {
	return attempt.stderr.split("\n").filter((line) => line.includes("not enforced"));
}

/** Every record in this attempt's delta that names `file`. */
function recordsNaming(attempt: CommitAttempt, file: string): string[] {
	return attempt.auditDelta.split("\n").filter((line) => line !== "" && line.includes(file));
}

// ---------------------------------------------------------------------------
// The retired binding path is inert (issue #68's amendment; SPEC §3.2, §4.2).
// ---------------------------------------------------------------------------

/**
 * The file below satisfies the retired delegation contract exactly —
 * `safe_source`, `audit_log`, `GHJIG_SHELL_HELPERS` — and additionally
 * defines a function named `exit`. A tier that SOURCES it hands its own
 * shell to it: the arms' refusals set a status that the redefined `exit`
 * discards, so the scan prints its refusal over a commit that lands. A tier
 * that never reads it cannot be reached by any of that.
 */
function plantRetiredBinding(root: string): void {
	mkdirSync(join(root, ".ghjig"), { recursive: true });
	writeFileSync(
		join(root, RETIRED_BINDING_REL),
		[
			"# zqplanted binding at the retired path (test substrate).",
			`GHJIG_SHELL_HELPERS='${join(root, ".githooks", "helpers")}'`,
			"export GHJIG_SHELL_HELPERS",
			"safe_source() {",
			'  if [ -f "$1" ]; then',
			'    . "$1"',
			"    return $?",
			"  fi",
			'  audit_log warn "${2:-git-hook-tier}" helper-missing "$(basename -- "$1")" || true',
			"  return 1",
			"}",
			`audit_log() { printf '%s\\n' "$*" >> '${join(root, "zqplanted-sink.log")}'; }`,
			"exit() { :; }",
			"",
		].join("\n"),
	);
}

describe("a file at the retired binding path cannot reach the hook's verdict (issue #68, SPEC §3.2, §4.2)", { skip: IS_WINDOWS }, () => {
	it("a file there that satisfies the retired contract and defines its own `exit` leaves the staged-secret refusal standing", () => {
		const fixture = buildDerivedFixture();
		try {
			plantRetiredBinding(fixture.root);
			stageFile(fixture, "zqinertleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the retired-binding inertness arm\n");
			assertSecretRefused(attempt, "zqinertleak.txt", "retired binding");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the key such a file would have admitted does not reach HEAD", () => {
		const fixture = buildDerivedFixture();
		try {
			plantRetiredBinding(fixture.root);
			stageFile(fixture, "zqinerthead.txt", `${AWS_SECRET}\n`);
			commitWithMessage(fixture, "chore: exercise the retired-binding history arm\n");
			const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
				cwd: fixture.root,
				env: constructedEnv(fixture.root),
				timeout: 30_000,
			});
			const names = (tree.stdout ?? Buffer.alloc(0)).toString("utf8");
			assert.equal(
				names.split("\n").includes("zqinerthead.txt"),
				false,
				`retired binding: the guarded path is in HEAD — a printed refusal over a landed commit is the ` +
					`one outcome this tier's face forbids (§3.2); HEAD carries: ${JSON.stringify(names)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The derivation itself (SPEC §3.2, §4.1, §4.2).
// ---------------------------------------------------------------------------

describe("an activated hooks path is the whole binding (issue #68, SPEC §3.2, §4.1)", { skip: IS_WINDOWS }, () => {
	it("a clone carrying no file under `.ghjig/` refuses a staged secret with the pattern ID on the derived record", () => {
		const fixture = buildDerivedFixture();
		try {
			assert.equal(
				existsSync(join(fixture.root, ".ghjig")),
				false,
				"derived arming: the fixture carries a `.ghjig/` of its own — the arm would measure that state " +
					"rather than the derivation",
			);
			stageFile(fixture, "zqderivedleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the derived-arming arm\n");
			assertSecretRefused(attempt, "zqderivedleak.txt", "derived arming");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a clean commit passes through that same chain", () => {
		const fixture = buildDerivedFixture();
		try {
			assertFixtureArmed(fixture, "zqcleanctl.txt", "clean commit");
			const attempt = commitWithMessage(fixture, "chore: exercise the clean-commit arm\n");
			assert.equal(
				attempt.status,
				0,
				`clean commit: an ordinary commit was refused by the armed chain; stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the refusal is carried by the derived helper location: redirecting that location to an empty directory turns the refusal into an allow", () => {
		const control = buildDerivedFixture();
		const mutant = buildDerivedFixture();
		try {
			stageFile(control, "zqmutctl.txt", `${AWS_SECRET}\n`);
			assertSecretRefused(
				commitWithMessage(control, "chore: exercise the derivation-mutant control\n"),
				"zqmutctl.txt",
				"derivation mutant control",
			);

			// The mutant overrides the DERIVED result at the end of the prelude
			// every adapter sources, so every arm below resolves its helper from
			// a directory that holds none. An arm that still refuses here was
			// never reading the derived location.
			const empty = join(mutant.root, "zqemptyhelpers");
			mkdirSync(empty);
			appendFileSync(
				join(mutant.root, ".githooks", "_lib.sh"),
				`\nGHJIG_SHELL_HELPERS='${empty}'\nexport GHJIG_SHELL_HELPERS\n`,
			);
			stageFile(mutant, "zqmutleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(mutant, "chore: exercise the derivation mutant\n");
			assert.equal(
				attempt.status,
				0,
				`derivation mutant: the commit was still refused with the helper location redirected to an ` +
					`empty directory — the refusal the control measured does not depend on the derived location, ` +
					`so that control pins nothing; stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(control);
			removeGithookFixture(mutant);
		}
	});
});

// ---------------------------------------------------------------------------
// Linked worktree (SPEC §5.2 per-worktree binding by the consumer's own
// resolution).
// ---------------------------------------------------------------------------

describe("a linked worktree enforces with no binding step of its own (issue #68, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	it("a staged secret inside a linked worktree of an activated clone is refused on that worktree's own record", () => {
		const fixture = buildDerivedFixture();
		try {
			fixtureGit(fixture, ["add", "--", ".githooks"]);
			fixtureGit(fixture, ["commit", "--no-verify", "-q", "-m", "chore: seed the worktree checkout tree"]);
			const wtRoot = join(fixture.root, "zqworktree");
			fixtureGit(fixture, ["worktree", "add", "-q", "-b", "zqwtbranch", wtRoot]);

			writeFileSync(join(wtRoot, "zqwtleak.txt"), `${AWS_SECRET}\n`);
			const env = constructedEnv(fixture.root);
			const add = spawnSync("git", ["add", "--", "zqwtleak.txt"], { cwd: wtRoot, env, timeout: 30_000 });
			assert.equal(add.status, 0, `linked worktree: staging failed: ${add.stderr?.toString("utf8")}`);
			const attempt = spawnSync("git", ["commit", "-q", "-m", "chore: exercise the linked-worktree arm"], {
				cwd: wtRoot,
				env,
				timeout: 60_000,
			});
			const stderr = (attempt.stderr ?? Buffer.alloc(0)).toString("utf8");
			assert.notEqual(
				attempt.status,
				0,
				`linked worktree: the staged key passed inside the worktree — a worktree of an activated clone ` +
					`resolves the same committed adapters and needs no binding step of its own (§5.2); ` +
					`stderr: ${JSON.stringify(stderr)}`,
			);
			assert.equal(
				stderr.includes(AWS_PATTERN_ID),
				true,
				`linked worktree: the refusal does not name pattern '${AWS_PATTERN_ID}': ${JSON.stringify(stderr)}`,
			);
			const sink = opSink(wtRoot);
			assert.equal(
				existsSync(sink) && readFileSync(sink, "utf8").includes(AWS_PATTERN_ID),
				true,
				`linked worktree: no record naming the pattern reached the worktree's own sink at ${sink} — the ` +
					`record sink derives from the repository top the hook runs against (§4.6)`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Degradation of the committed helper set (SPEC §3.2, §5.2, §3.9).
// ---------------------------------------------------------------------------

describe("an unresolvable helper set folds the tier to allow and says it is not enforced (issue #68 AC7, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	it("an absent helper directory folds the commit to allow", () => {
		const fixture = buildDerivedFixture();
		try {
			assertFixtureArmed(fixture, "zqnohelpersctl.txt", "absent helper directory");
			rmSync(join(fixture.root, ".githooks", "helpers"), { recursive: true, force: true });
			stageFile(fixture, "zqnohelpersleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the absent-helper-directory arm\n");
			assert.equal(
				attempt.status,
				0,
				`absent helper directory: the degraded tier blocked instead of folding open — an enforcement ` +
					`chain the acting party did not break and cannot repair from inside a block fails open ` +
					`(§4.5); stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("an absent helper directory says the tier is not enforced", () => {
		const fixture = buildDerivedFixture();
		try {
			assertFixtureArmed(fixture, "zqnohelperssayctl.txt", "absent helper directory signal");
			rmSync(join(fixture.root, ".githooks", "helpers"), { recursive: true, force: true });
			stageFile(fixture, "zqnohelperssayleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the absent-helper-directory signal arm\n");
			assert.notEqual(
				notEnforcedLines(attempt).length,
				0,
				`absent helper directory: the fold left no "not enforced" line, so a disarmed allow is ` +
					`indistinguishable from an enforced pass (§3.9's degradation-signal rule); ` +
					`stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("one absent helper file folds its own arm to allow and leaves exactly one record naming that helper", () => {
		const fixture = buildDerivedFixture();
		try {
			assertFixtureArmed(fixture, "zqonehelperctl.txt", "absent helper file");
			rmSync(helperPath(fixture.root, "secret_scan.sh"), { force: true });
			stageFile(fixture, "zqonehelperleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the absent-helper-file arm\n");
			assert.equal(
				attempt.status,
				0,
				`absent helper file: the degraded arm blocked instead of folding open (§3.2); ` +
					`stderr: ${JSON.stringify(attempt.stderr)}`,
			);
			assert.equal(
				recordsNaming(attempt, "secret_scan.sh").length,
				1,
				`absent helper file: expected exactly one record naming the missing helper — stderr is routinely ` +
					`discarded in scripted git, so a fold whose only trace is a stderr line leaves the sink ` +
					`byte-identical to an ordinary allow (§3.9's uniform channel); ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// A sourced helper that does not complete (issue #68 AC7, SPEC §5.2's
// fold-that-names-itself, §3.9).
// ---------------------------------------------------------------------------

/**
 * Three shapes of one family: a sourced file that does not hand control
 * back with a zero status. `exit` terminates the sourcing shell — the hook
 * itself — so its status leaves as the hook's, which git reads as a
 * refusal; a parse failure and a non-zero `return` hand back a status the
 * source line must not carry into a verdict. All three fold the arm to
 * allow, and none of them may fold silently.
 */
const INCOMPLETE_SOURCE_SHAPES = [
	{ label: "exits with a status", suffix: "\nexit 9\n" },
	{ label: "fails to parse", suffix: "\nif [ 1 -eq 1 ; then\n" },
	{ label: "returns a non-zero status", suffix: "\nreturn 3\n" },
] as const;

describe("a helper that does not finish sourcing folds its arm to allow and names the file (issue #68 AC7, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	for (const shape of INCOMPLETE_SOURCE_SHAPES) {
		it(`a helper that ${shape.label} while being sourced folds the commit to allow`, () => {
			const fixture = buildDerivedFixture();
			try {
				assertFixtureArmed(fixture, `zqsrc-allow-${shape.label.split(" ")[0]}.txt`, `source ${shape.label}`);
				appendFileSync(helperPath(fixture.root, "secret_scan.sh"), shape.suffix);
				stageFile(fixture, "zqsrcleak.txt", `${AWS_SECRET}\n`);
				const attempt = commitWithMessage(fixture, "chore: exercise the incomplete-source fold\n");
				assert.equal(
					attempt.status,
					0,
					`source ${shape.label}: the commit was refused because a sourced helper did not hand control ` +
						`back cleanly — a refusal produced by machinery rather than by a check, in the direction ` +
						`this advice tier never takes (§5.2); stderr: ${JSON.stringify(attempt.stderr)}`,
				);
			} finally {
				removeGithookFixture(fixture);
			}
		});

		it(`a helper that ${shape.label} while being sourced leaves exactly one record naming that file`, () => {
			const fixture = buildDerivedFixture();
			try {
				assertFixtureArmed(fixture, `zqsrc-rec-${shape.label.split(" ")[0]}.txt`, `source ${shape.label} record`);
				appendFileSync(helperPath(fixture.root, "secret_scan.sh"), shape.suffix);
				stageFile(fixture, "zqsrcrecleak.txt", `${AWS_SECRET}\n`);
				const attempt = commitWithMessage(fixture, "chore: exercise the incomplete-source record\n");
				assert.equal(
					recordsNaming(attempt, "secret_scan.sh").length,
					1,
					`source ${shape.label}: expected exactly one record naming the helper whose source did not ` +
						`complete — the observable that separates this disarmed allow from an ordinary one ` +
						`(§3.9); delta: ${JSON.stringify(attempt.auditDelta)}`,
				);
			} finally {
				removeGithookFixture(fixture);
			}
		});
	}

	it("the fold leaves one stderr line per adapter that reaches it: a commit folding both adapters says so twice", () => {
		const fixture = buildDerivedFixture();
		try {
			assertFixtureArmed(fixture, "zqtwoadapterctl.txt", "two-adapter fold");
			// pre-commit reaches branch_guard.sh; commit-msg reaches
			// conventional_commit.sh. One `git commit` runs both adapters, and a
			// shared degraded helper set never collapses two surfaces' signals
			// into one (§5.2's per-adapter count).
			appendFileSync(helperPath(fixture.root, "branch_guard.sh"), "\nexit 9\n");
			appendFileSync(helperPath(fixture.root, "conventional_commit.sh"), "\nexit 9\n");
			stageFile(fixture, "zqtwoadapterleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the two-adapter fold\n");
			assert.equal(
				notEnforcedLines(attempt).length,
				2,
				`two-adapter fold: expected one "not enforced" line per adapter that reached the fold ` +
					`(pre-commit and commit-msg), so a fold on one surface is never read as a fold on both ` +
					`(§5.2); stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Out-of-top refusal (SPEC §5.5's boundary, §4.1's derivation bound).
// ---------------------------------------------------------------------------

interface CrossRepoPair {
	/** Holds both repositories; nothing this arm measures may be written outside it. */
	tmp: string;
	governed: string;
	ungoverned: string;
}

/**
 * A governed clone carrying the committed `.githooks/` tree, and a second,
 * ungoverned repository whose `core.hooksPath` is an ABSOLUTE path into the
 * first one's hooks directory. The hooks then run against a repository top
 * that does not contain the file they were resolved from.
 */
function buildCrossRepoPair(): CrossRepoPair {
	const tmp = mkdtempSync(join(tmpdir(), "ghjig-crossrepo-"));
	const governed = join(tmp, "governed");
	const ungoverned = join(tmp, "ungoverned");
	for (const root of [governed, ungoverned]) {
		mkdirSync(join(root, "home"), { recursive: true });
		const env = constructedEnv(root);
		for (const args of [
			["-c", "init.defaultBranch=zqcrossmain", "init", "-q"],
			["config", "user.name", "fixture"],
			["config", "user.email", "fixture@invalid"],
			["config", "commit.gpgsign", "false"],
		]) {
			const result = spawnSync("git", args, { cwd: root, env, timeout: 30_000 });
			if (result.status !== 0) {
				throw new Error(`substrate: git ${args.join(" ")} exited ${result.status}`);
			}
		}
	}
	cpSync(join(repoRoot(), ".githooks"), join(governed, ".githooks"), { recursive: true });
	// The governed clone activates its own hooks path, so the control below
	// measures the same hooks tree inside its own repository.
	for (const [root, value] of [
		[governed, ".githooks"],
		[ungoverned, join(governed, ".githooks")],
	] as const) {
		const set = spawnSync("git", ["config", "core.hooksPath", value], {
			cwd: root,
			env: constructedEnv(root),
			timeout: 30_000,
		});
		if (set.status !== 0) {
			throw new Error(`substrate: could not set core.hooksPath in ${root}`);
		}
	}
	return { tmp, governed, ungoverned };
}

/**
 * The control both cross-repository arms owe (header note): the SAME hooks
 * tree refuses inside its own repository, so a silence or a still tree
 * measured across the boundary is the boundary and not a dead fixture.
 */
function assertPairArmed(pair: CrossRepoPair, marker: string): void {
	const control = commitIn(pair.governed, marker);
	assert.notEqual(
		control.status,
		0,
		`cross-repository control: the governed clone's own chain allowed a staged key, so the arm it ` +
			`precedes would measure a dead fixture; stderr: ${JSON.stringify(control.stderr)}`,
	);
}

/** Stage a pattern-matching key and attempt a commit in `root`. */
function commitIn(root: string, name: string): { status: number | null; stderr: string } {
	writeFileSync(join(root, name), `${AWS_SECRET}\n`);
	const env = constructedEnv(root);
	spawnSync("git", ["add", "--", name], { cwd: root, env, timeout: 30_000 });
	const result = spawnSync("git", ["commit", "-q", "-m", "chore: exercise the cross-repository arm"], {
		cwd: root,
		env,
		timeout: 60_000,
	});
	return { status: result.status, stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8") };
}

describe("a helper location outside the repository the hook runs against runs no check (issue #68, SPEC §5.5)", { skip: IS_WINDOWS }, () => {
	it("the tier says it is not enforced there", () => {
		const pair = buildCrossRepoPair();
		try {
			assertPairArmed(pair, "zqcrossctl.txt");
			const attempt = commitIn(pair.ungoverned, "zqcrossleak.txt");
			assert.equal(
				attempt.stderr.split("\n").some((line) => line.includes("not enforced")),
				true,
				`cross-repository: the tier ran against a repository that does not contain the helpers it ` +
					`resolved and said nothing — a gate that resolves its checks outside the repository it was ` +
					`invoked in must run no check and say so (§5.5); stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			rmSync(pair.tmp, { recursive: true, force: true });
		}
	});

	it("no byte is written into the repository it was invoked in", () => {
		const pair = buildCrossRepoPair();
		try {
			assertPairArmed(pair, "zqcrosswritectl.txt");
			const governedBefore = listTreeSizes(pair.governed);
			commitIn(pair.ungoverned, "zqcrosswriteleak.txt");
			assert.equal(
				existsSync(join(pair.ungoverned, ".ghjig")),
				false,
				`cross-repository: the tier created its own state namespace inside a repository that never ` +
					`adopted it — shell state is written only inside governed repositories (§5.5)`,
			);
			assert.deepEqual(
				listTreeSizes(pair.governed),
				governedBefore,
				"cross-repository: the governed repository's tree changed while the hook ran against another " +
					"repository (§5.5's write scope)",
			);
		} finally {
			rmSync(pair.tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// The record writer, moved rather than re-derived (SPEC §5.5).
// ---------------------------------------------------------------------------

/**
 * A staged path carrying a double quote, a backslash, a tab, a newline and
 * a C0 control byte — every byte class that can close a record's field,
 * split one record into two, or forge a second one. The path also carries
 * the key, so one commit exercises the sanitizer and §3.8's content-free
 * refusal at the same time.
 */
const HOSTILE_NAME =
	`zqhost${cp(0x22)}q${cp(0x5c)}b${cp(0x09)}t${cp(0x0a)}n${cp(0x01)}c.txt`;

describe("the record writer sanitizes free text at the write (issue #68, SPEC §5.5)", { skip: IS_WINDOWS }, () => {
	it("a hostile staged path lands whole records only, each one well-formed JSON on its own line", () => {
		const fixture = buildDerivedFixture();
		try {
			stageFile(fixture, HOSTILE_NAME, `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the sanitizer arm\n");
			const lines = attempt.auditDelta.split("\n").filter((line) => line !== "");
			assert.notEqual(
				lines.length,
				0,
				`sanitizer: the refusal wrote no record at all, so nothing about the write is measured here; ` +
					`stderr: ${JSON.stringify(attempt.stderr)}`,
			);
			for (const line of lines) {
				assert.doesNotThrow(
					() => JSON.parse(line),
					`sanitizer: an appended line is not one well-formed record — a field's content closed its ` +
						`field or opened another (§5.5): ${JSON.stringify(line)}`,
				);
			}
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("no control byte from a hostile staged path reaches the record", () => {
		const fixture = buildDerivedFixture();
		try {
			stageFile(fixture, HOSTILE_NAME, `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the control-byte arm\n");
			const delta = Buffer.from(attempt.auditDelta, "utf8");
			assert.notEqual(delta.length, 0, "control bytes: the refusal wrote no record, so the arm measures nothing");
			const raw = [...delta].filter((byte) => (byte < 0x20 && byte !== 0x0a) || byte === 0x7f);
			assert.deepEqual(
				raw,
				[],
				`control bytes: raw control bytes reached the record — control bytes are removed at the write ` +
					`(§5.5): ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the key's bytes reach neither stream nor record, whatever the staged path carries", () => {
		const fixture = buildDerivedFixture();
		try {
			stageFile(fixture, HOSTILE_NAME, `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the hostile-path leak arm\n");
			assertSecretRefused(attempt, "zqhost", "hostile path");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("concurrent writers interleave whole records only", async () => {
		const fixture = buildDerivedFixture();
		try {
			const sink = opSink(fixture.root);
			const before = existsSync(sink)
				? readFileSync(sink, "utf8").split("\n").filter((line) => line !== "").length
				: 0;
			// The tier's own record writer, driven directly: it is committed code
			// of the prelude every adapter sources, and concurrency is not
			// reachable through a single `git commit`.
			const pad = "zqpad".repeat(60);
			const script = '. "$1"\nfor i in $(seq 1 25); do audit_log warn secret "zqconcurrent $i $2"; done';
			const children = [1, 2, 3, 4].map(() =>
				spawn("bash", ["-c", script, "bash", join(fixture.root, ".githooks", "_lib.sh"), pad], {
					cwd: fixture.root,
					env: constructedEnv(fixture.root),
				}),
			);
			await Promise.all(
				children.map(
					(child) =>
						new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => {
								child.kill("SIGKILL");
								reject(new Error("concurrent writers: a writer hung (timeout wrap)"));
							}, 60_000);
							child.on("close", () => {
								clearTimeout(timer);
								resolve();
							});
						}),
				),
			);
			const lines = (existsSync(sink) ? readFileSync(sink, "utf8") : "")
				.split("\n")
				.filter((line) => line !== "");
			assert.equal(
				lines.length - before,
				100,
				`concurrent writers: the appended line count does not match the write count — an append merged ` +
					`or split records, so one record no longer equals one line (§5.5); got ${lines.length - before} ` +
					`of 100`,
			);
			for (const line of lines) {
				assert.doesNotThrow(
					() => JSON.parse(line),
					`concurrent writers: an interleaved line is not one well-formed record: ${JSON.stringify(line)}`,
				);
			}
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

/**
 * Every component of the state namespace the writer creates. A link at any
 * of them is another writer's target: `mkdir -p` and an append alike would
 * follow it, and the record would land outside the namespace §4.1 gives the
 * shell — in a repository §5.5's boundary excludes.
 */
const NAMESPACE_COMPONENTS = [
	{ label: ".ghjig", plant: join(".ghjig") },
	{ label: ".ghjig/state", plant: join(".ghjig", "state") },
	{ label: `.ghjig/state/${AUDIT_FILE_NAME}`, plant: join(".ghjig", "state", AUDIT_FILE_NAME) },
] as const;

describe("the record writer refuses to write through a link at any component it creates (issue #68, SPEC §5.5)", { skip: IS_WINDOWS }, () => {
	for (const component of NAMESPACE_COMPONENTS) {
		it(`a symbolic link at ${component.label} gains no record and the refusal still stands`, () => {
			const fixture = buildDerivedFixture();
			try {
				const victim = join(fixture.root, "zqvictim");
				mkdirSync(victim);
				const victimFile = join(victim, "zqvictim.txt");
				writeFileSync(victimFile, "zqvictimbytes\n");
				const plant = join(fixture.root, component.plant);
				mkdirSync(join(plant, ".."), { recursive: true });
				symlinkSync(component.plant.endsWith(AUDIT_FILE_NAME) ? victimFile : victim, plant);
				const victimBefore = listTreeSizes(victim);

				stageFile(fixture, "zqlinkleak.txt", `${AWS_SECRET}\n`);
				const attempt = commitWithMessage(fixture, "chore: exercise the linked-component arm\n");
				assert.notEqual(
					attempt.status,
					0,
					`${component.label} link: the staged key passed — enforcement stands whatever becomes of a ` +
						`record, since a refusal prints and returns non-zero on its own (§5.2); ` +
						`stderr: ${JSON.stringify(attempt.stderr)}`,
				);
				assert.deepEqual(
					listTreeSizes(victim),
					victimBefore,
					`${component.label} link: the write followed the link and landed outside the shell's own ` +
						`namespace (§5.5)`,
				);
			} finally {
				removeGithookFixture(fixture);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Push-surface stdin discipline (SPEC §3.2).
// ---------------------------------------------------------------------------

describe("the push adapter's ref iteration reads every line git streams (issue #68, SPEC §3.2)", { skip: IS_WINDOWS }, () => {
	it("a multi-ref push carrying the protected ref on line 2 is refused", () => {
		const fixture = buildDerivedFixture();
		try {
			const companion = "zqderivedcompanionzq";
			const create = pushRefs(fixture, [`${FEATURE}:${companion}`]);
			assert.equal(create.status, 0, `push stdin: the companion ref could not be created: ${create.stderr}`);
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [`${FEATURE}:${companion}`, `${FEATURE}:${PROTECTED}`]);
			assert.notEqual(
				attempt.status,
				0,
				`push stdin: a push whose protected ref arrives past line 1 was allowed — a check that consumes ` +
					`stdin removes ref lines from the adapter's iteration, and the arm then measures fewer refs ` +
					`than the push carries (§3.2); stderr: ${JSON.stringify(attempt.stderr)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Namespace census (SPEC §4.1, §4.2): nothing generated beside the committed
// bytes.
// ---------------------------------------------------------------------------

describe("the armed tier writes no code into the clone (issue #68, SPEC §4.2)", { skip: IS_WINDOWS }, () => {
	it("everything under `.ghjig/` after an enforced refusal is the record sink, and nothing else", () => {
		const fixture = buildDerivedFixture();
		try {
			stageFile(fixture, "zqcensusleak.txt", `${AWS_SECRET}\n`);
			const attempt = commitWithMessage(fixture, "chore: exercise the namespace census\n");
			assert.notEqual(attempt.status, 0, "namespace census: the chain did not fire, so its write set is not measured");
			assert.deepEqual(
				listTreeEntries(join(fixture.root, ".ghjig")).sort(),
				["state", join("state", AUDIT_FILE_NAME)].sort(),
				"namespace census: `.ghjig/` carries something other than the record sink — per-clone state is " +
					"data the shell writes, never code it executes (§4.2)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
