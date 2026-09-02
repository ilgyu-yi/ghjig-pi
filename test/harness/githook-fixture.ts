/**
 * Shared git-hook fixture builder (issue #55; reusable by sibling suites).
 *
 * Builds a disposable git repository that exercises the committed local-tier
 * chain exactly as a bound clone runs it:
 *
 *   - THIS repository's `.githooks/` tree is copied into the fixture at the
 *     SAME relative path, and the copy is verified byte-for-byte against the
 *     source before any arm runs — a fixture that re-arranges or edits the
 *     layout can go green while the real checkout stays inert, so the
 *     builder refuses to hand out a divergent copy;
 *   - `core.hooksPath` is set to `.githooks`, the binding a governed clone
 *     carries (§3.4);
 *   - an untracked `.ghjig/shell-adapter.sh` provides exactly the surface
 *     `.githooks/_lib.sh` requires of a per-clone binding: `safe_source`
 *     (fail-open non-zero on a missing helper file), `audit_log`
 *     (observable — appends one line per record to a fixture-local file the
 *     arms can read), and `GHJIG_SHELL_HELPERS`. The helper dir defaults to
 *     the fixture's copy of `.githooks/helpers` — the committed helper home
 *     (§4.1) — so behavioral arms measure the shipped helper bytes;
 *     degradation arms point it at a fixture-local dir they control.
 *
 * Every check drives `git commit` through this fixture, never a predicate
 * function directly, so the arms measure the chain an operator actually
 * runs: adapter → `_lib.sh` → helper dir → predicate → block.
 *
 * The commit environment is CONSTRUCTED, never inherited wholesale: PATH is
 * passed through (git and bash must resolve), HOME is fixture-local,
 * gitconfig is repo-local only (`GIT_CONFIG_NOSYSTEM`), terminal prompts are
 * disabled (`GIT_TERMINAL_PROMPT=0` — no fixture operation may wait on a
 * credential prompt), and the locale is pinned to a multibyte-capable
 * charmap (`en_US.UTF-8`) so codepoint measurement has a defined baseline;
 * an arm that needs a degraded measurement environment overrides the locale
 * explicitly on its own commit. POSIX substrate only: suites that use this
 * builder skip on win32.
 *
 * PUSH SUBSTRATE (issue #59). The `remote` option adds a fixture-local bare
 * remote named `origin`, so push-shaped arms can drive `git push` through
 * the committed `pre-push` adapter against a real receive end:
 *
 *   - `git init --bare` + `git remote add origin <path>` + one initial push
 *     of the default branch, then `git remote set-head origin <name>` — in
 *     that order, because `set-head` refuses until the tracking ref the
 *     push creates exists (`git remote add` alone never writes
 *     `refs/remotes/origin/HEAD`);
 *   - `omitHeadPointer` skips the `set-head` step, leaving
 *     `refs/remotes/origin/HEAD` absent — the clone-configuration shape a
 *     manually-added remote carries (derivation-failure arms);
 *   - `danglingRemoteHead` points the bare remote's own HEAD at a branch
 *     that does not exist, after the initial push: `git ls-remote --symref
 *     origin HEAD` then yields empty output with exit 0 — the
 *     stage-2-failure shape keyed by outcome, not cause;
 *   - the setup commit and setup push run with `--no-verify`: fixture
 *     construction is substrate, never a measurement, and must not depend
 *     on the chain state the arms are about to measure.
 */
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./run-pi.ts";

export interface GithookFixture {
	root: string;
	/** The directory the adapter's GHJIG_SHELL_HELPERS points at. */
	helpersDir: string;
	/** Where the adapter's `audit_log` appends — one line per record. */
	auditFile: string;
	/** Per-fixture counter; makes every commit attempt stage a fresh change. */
	seq: number;
}

export interface GithookFixtureOptions {
	/**
	 * Where GHJIG_SHELL_HELPERS points, relative to the fixture root.
	 * Default `.githooks/helpers` — the fixture copy of the committed
	 * helper home (§4.1). Degradation arms override this to a dir whose
	 * contents they author (absent helper, stub helper).
	 */
	helpersRelative?: string;
	/** Add a fixture-local bare remote (see the header's push-substrate note). */
	remote?: GithookRemoteOptions;
}

export interface GithookRemoteOptions {
	/**
	 * The branch the bare remote advertises as its default — the identity a
	 * protected-branch predicate can derive. Suites choose a DISTINCTIVE
	 * name (never `main`) so byte-level "this name reached no surface"
	 * assertions cannot collide with incidental git output.
	 */
	defaultBranch: string;
	/**
	 * Skip `git remote set-head origin <name>`: `refs/remotes/origin/HEAD`
	 * stays absent, as it does in any clone whose remote was added by
	 * `git remote add` and never `clone`d or `set-head`ed.
	 */
	omitHeadPointer?: boolean;
	/**
	 * After the initial push, point the bare remote's HEAD at a branch that
	 * does not exist: a subsequent `git ls-remote --symref origin HEAD`
	 * yields empty output with exit 0.
	 */
	danglingRemoteHead?: boolean;
}

export interface CommitAttempt {
	status: number | null;
	stdout: string;
	stderr: string;
	/**
	 * Raw stdout bytes — stdout sits in the leak-assertion domain (§3.8's
	 * refusal-record rule): a guarded value's absence must be provable at
	 * byte fidelity on every surface the operator sees, stdout included.
	 */
	stdoutBytes: Buffer;
	/** Raw stderr bytes — for arms that must prove non-UTF-8 subject bytes never surface. */
	stderrBytes: Buffer;
	/** The audit-file lines this one commit attempt appended ("" when none). */
	auditDelta: string;
	/**
	 * The predicate-owned share of stderr: every non-empty line except the
	 * adapter's own `[dev-shell] …` recovery line (§3.11's division — the
	 * checker emits the cause, each calling surface appends the recovery
	 * live at that surface).
	 */
	cause: string;
}

export interface CommitOptions {
	/** Per-commit environment overrides, merged over the constructed base. */
	env?: Record<string, string>;
	/** Extra `git commit` arguments, inserted before `-F` (e.g. `--cleanup=verbatim`). */
	gitArgs?: string[];
}

function baseEnv(fixture: GithookFixture): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(fixture.root, "home"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
	};
}

function git(fixture: GithookFixture, args: string[]): void {
	const result = spawnSync("git", args, { cwd: fixture.root, env: baseEnv(fixture) });
	if (result.status !== 0) {
		throw new Error(
			`fixture setup: git ${args.join(" ")} exited ${result.status}: ${result.stderr?.toString("utf8")}`,
		);
	}
}

/**
 * Byte-for-byte parity between the source tree and its fixture copy: same
 * relative entries, same bytes, and the executable bit intact on every
 * top-level hook. A silent copy divergence here is exactly the shape that
 * lets a suite go green against bytes the real checkout does not run.
 */
function assertTreesIdentical(sourceDir: string, copyDir: string): void {
	const listFiles = (dir: string, prefix: string, out: string[]): void => {
		for (const item of [...readdirSync(dir, { withFileTypes: true })].sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
			if (item.isDirectory()) {
				listFiles(join(dir, item.name), rel, out);
			} else {
				out.push(rel);
			}
		}
	};
	const sourceFiles: string[] = [];
	const copyFiles: string[] = [];
	listFiles(sourceDir, "", sourceFiles);
	listFiles(copyDir, "", copyFiles);
	if (sourceFiles.join("\n") !== copyFiles.join("\n")) {
		throw new Error(
			`fixture .githooks copy diverges from the source layout:\nsource: ${sourceFiles.join(", ")}\ncopy: ${copyFiles.join(", ")}`,
		);
	}
	for (const rel of sourceFiles) {
		const sourceBytes = readFileSync(join(sourceDir, ...rel.split("/")));
		const copyBytes = readFileSync(join(copyDir, ...rel.split("/")));
		if (!sourceBytes.equals(copyBytes)) {
			throw new Error(`fixture .githooks copy diverges from the source bytes at ${rel}`);
		}
	}
	for (const rel of sourceFiles) {
		if (rel.includes("/")) {
			continue; // only the top-level hook-named files must be executable
		}
		if ((statSync(join(copyDir, rel)).mode & 0o100) === 0) {
			throw new Error(`fixture hook ${rel} lost its executable bit — git would never fire it`);
		}
	}
}

export function buildGithookFixture(options: GithookFixtureOptions = {}): GithookFixture {
	const root = mkdtempSync(join(tmpdir(), "ghjig-githook-"));
	mkdirSync(join(root, "home"));

	const sourceHooks = join(repoRoot(), ".githooks");
	const copiedHooks = join(root, ".githooks");
	cpSync(sourceHooks, copiedHooks, { recursive: true });
	assertTreesIdentical(sourceHooks, copiedHooks);

	const helpersDir = join(root, options.helpersRelative ?? join(".githooks", "helpers"));
	mkdirSync(helpersDir, { recursive: true });
	const auditFile = join(root, "audit.log");

	const fixture: GithookFixture = { root, helpersDir, auditFile, seq: 0 };
	git(fixture, ["-c", "init.defaultBranch=main", "init", "-q"]);
	git(fixture, ["config", "user.name", "fixture"]);
	git(fixture, ["config", "user.email", "fixture@invalid"]);
	git(fixture, ["config", "commit.gpgsign", "false"]);
	git(fixture, ["config", "core.hooksPath", ".githooks"]);

	mkdirSync(join(root, ".ghjig"));
	writeFileSync(
		join(root, ".ghjig", "shell-adapter.sh"),
		[
			"# .ghjig/shell-adapter.sh — per-clone binding stub (test substrate).",
			"# Provides exactly the surface .githooks/_lib.sh requires of a binding:",
			"# safe_source (fail-open non-zero on a missing helper), audit_log",
			"# (appends one line per record to a fixture-local file), and",
			"# GHJIG_SHELL_HELPERS.",
			`GHJIG_SHELL_HELPERS='${helpersDir}'`,
			"export GHJIG_SHELL_HELPERS",
			"safe_source() {",
			'  if [ -f "$1" ]; then',
			'    . "$1"',
			"    return $?",
			"  fi",
			'  audit_log warn "${2:-git-hook-tier}" helper-missing "$(basename -- "$1")" || true',
			"  return 1",
			"}",
			"audit_log() {",
			`  printf '%s\\n' "$*" >> '${auditFile}'`,
			"}",
			"",
		].join("\n"),
	);

	if (options.remote) {
		const { defaultBranch, omitHeadPointer, danglingRemoteHead } = options.remote;
		// Rename the unborn branch BEFORE the first commit so the fixture's
		// local default and the remote's advertised default share one name.
		git(fixture, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
		seedLocalCommit(fixture);
		const remotePath = join(root, "remote.git");
		git(fixture, ["init", "-q", "--bare", remotePath]);
		git(fixture, ["--git-dir", remotePath, "symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
		git(fixture, ["remote", "add", "origin", remotePath]);
		// --no-verify: substrate, not measurement (header note). This push
		// also creates refs/remotes/origin/<defaultBranch>, the tracking ref
		// set-head requires — the order below is load-bearing.
		git(fixture, ["push", "--no-verify", "-q", "origin", defaultBranch]);
		if (!omitHeadPointer) {
			git(fixture, ["remote", "set-head", "origin", defaultBranch]);
		}
		if (danglingRemoteHead) {
			git(fixture, ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/ghjig-absent-branch"]);
		}
	}
	return fixture;
}

/** Run one fixture-scoped git command that must succeed (setup substrate). */
export function fixtureGit(fixture: GithookFixture, args: string[]): void {
	git(fixture, args);
}

/**
 * Advance the fixture branch by one commit WITHOUT measuring the hook chain
 * (`--no-verify`): a push arm needs the local branch ahead of the remote —
 * an up-to-date push never fires pre-push at all — and how that commit came
 * to exist is substrate, not the arm's subject.
 */
export function seedLocalCommit(fixture: GithookFixture): void {
	fixture.seq += 1;
	appendFileSync(join(fixture.root, "work.txt"), `seed ${fixture.seq}\n`);
	git(fixture, ["add", "work.txt"]);
	git(fixture, ["commit", "--no-verify", "-q", "-m", "chore: advance the fixture branch"]);
}

export function removeGithookFixture(fixture: GithookFixture): void {
	rmSync(fixture.root, { recursive: true, force: true });
}

/**
 * Stage a fresh change and attempt `git commit -F <message>` through the
 * fixture's hook chain. The message travels as BYTES (a Buffer caller can
 * carry invalid UTF-8 or control bytes); the file lands under `.git/` so a
 * hostile message never dirties the fixture worktree.
 */
export function commitWithMessage(
	fixture: GithookFixture,
	message: string | Buffer,
	options: CommitOptions = {},
): CommitAttempt {
	fixture.seq += 1;
	appendFileSync(join(fixture.root, "work.txt"), `change ${fixture.seq}\n`);
	git(fixture, ["add", "work.txt"]);

	const messageFile = join(fixture.root, ".git", "GHJIG_TEST_MSG");
	writeFileSync(messageFile, message);

	const auditBefore = existsSync(fixture.auditFile) ? readFileSync(fixture.auditFile, "utf8") : "";
	const result = spawnSync("git", ["commit", ...(options.gitArgs ?? []), "-F", messageFile], {
		cwd: fixture.root,
		env: { ...baseEnv(fixture), ...(options.env ?? {}) },
	});
	const auditAfter = existsSync(fixture.auditFile) ? readFileSync(fixture.auditFile, "utf8") : "";

	const stderrBytes = result.stderr ?? Buffer.alloc(0);
	const stdoutBytes = result.stdout ?? Buffer.alloc(0);
	const stderr = stderrBytes.toString("utf8");
	return {
		status: result.status,
		stdout: stdoutBytes.toString("utf8"),
		stderr,
		stdoutBytes,
		stderrBytes,
		auditDelta: auditAfter.slice(auditBefore.length),
		cause: stderr
			.split("\n")
			.filter((line) => line !== "" && !line.startsWith("[dev-shell]"))
			.join("\n"),
	};
}

export interface PushOptions {
	/** Per-push environment overrides, merged over the constructed base. */
	env?: Record<string, string>;
	/** Extra `git push` arguments, inserted before the remote name (e.g. `--force`). */
	gitArgs?: string[];
}

/**
 * Attempt `git push [gitArgs] origin <refspecs…>` through the fixture's
 * hook chain — the push counterpart of `commitWithMessage`, returning the
 * same observable shape. Two facts a caller must hold:
 *
 *   - pre-push fires only when at least one refspec is NOT up to date;
 *     an arm that re-pushes the default branch advances it first
 *     (`seedLocalCommit`);
 *   - on a refused push, git's own stderr adds only its generic
 *     failed-to-push line naming the remote PATH — the refspec's names are
 *     never echoed by git itself, so byte-level "this refname reached no
 *     surface" assertions measure the hook chain's emissions alone.
 */
export function pushRefs(
	fixture: GithookFixture,
	refspecs: string[],
	options: PushOptions = {},
): CommitAttempt {
	const auditBefore = existsSync(fixture.auditFile) ? readFileSync(fixture.auditFile, "utf8") : "";
	const result = spawnSync("git", ["push", ...(options.gitArgs ?? []), "origin", ...refspecs], {
		cwd: fixture.root,
		env: { ...baseEnv(fixture), ...(options.env ?? {}) },
	});
	const auditAfter = existsSync(fixture.auditFile) ? readFileSync(fixture.auditFile, "utf8") : "";

	const stderrBytes = result.stderr ?? Buffer.alloc(0);
	const stdoutBytes = result.stdout ?? Buffer.alloc(0);
	const stderr = stderrBytes.toString("utf8");
	return {
		status: result.status,
		stdout: stdoutBytes.toString("utf8"),
		stderr,
		stdoutBytes,
		stderrBytes,
		auditDelta: auditAfter.slice(auditBefore.length),
		cause: stderr
			.split("\n")
			.filter((line) => line !== "" && !line.startsWith("[dev-shell]"))
			.join("\n"),
	};
}
