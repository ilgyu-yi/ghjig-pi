/**
 * Hermetic pi test harness (SPEC §4.4; issue #4 spike note).
 *
 * Builds a disposable project fixture in the OS temp directory and drives
 * `pi` against it with the scripted provider (`scripted-provider.ts`,
 * copied in at build time). Every run:
 *
 *   - closes stdin explicitly (spike finding 2: an open stdin hangs `-p`),
 *   - passes the project-trust flag `-a` (spike finding 4),
 *   - pins session storage to `<fixture>/sessions` via `--session-dir`,
 *   - isolates pi's own config (`HOME`, `PI_CODING_AGENT_DIR`) inside the
 *     fixture and disables startup network work (`PI_OFFLINE=1`),
 *   - sets the single test-only state seam `GHJIG_TEST_STATE_ROOT` to
 *     `<fixture>/state` (§5.5 disposable-root carve-out), replaceable only
 *     through the explicit `seamOverride` option and never through `env`.
 *
 * The optional `gitRepo` option builds a real git repository at
 * `<fixture>/repo` for the arms that measure ref identity. Its git
 * invocations run against a fixture-owned global config file and with the
 * system config disabled, and `withRepoGitAmbient` extends the same pinning
 * to this process while a gate is measured — the host's git configuration is
 * never an input to a result, and never a destination (§4.7, §3.12). With
 * `projectDir: "gitRepo"` that repository is also the session's working
 * directory, which is the layout an end-to-end gate arm needs: pi discovers
 * project extensions at `<cwd>/.pi/extensions/` and never walks upward, so
 * a session whose cwd is a repository has to keep its extensions there.
 *
 * The ghjig runtime under test comes from THIS repository's tree
 * (`.pi/extensions/ghjig.ts` + `.pi/extensions/ghjig/`) either way, so every
 * suite exercises the committed bytes; the two arrangements differ in WHICH
 * REPOSITORY the loaded module belongs to, which is a property the runtime
 * reads about itself:
 *
 *   - `copyGhjigRuntime` places it inside the fixture, so it self-locates to
 *     the repository the session works in — one repository, governing
 *     itself, which is the shape of an adopter's clone and the arrangement
 *     any arm about scope needs.
 *   - `linkGhjigRuntime` leaves it belonging to this repository while the
 *     session works in a temporary fixture — two different repositories, on
 *     purpose. That is the arrangement for an arm about self-location or
 *     about the linking path itself, and an arm that uses it is saying so.
 *
 * `RunOptions.seamUnset` is admissible only under the copy, and the harness
 * refuses the other combination outright.
 *
 * Invocation contract: run the suites as `node --test "test/*.test.ts"`.
 * A bare `node --test` must NOT be used — node's default discovery treats
 * every file under a `test/` directory as a test and would execute the
 * harness assets themselves; `scripted-provider.ts` resolves its
 * `@earendil-works/*` imports only under pi's loader, so that shape
 * false-reds on a harness asset instead of measuring the runtime (§3.12).
 */
import { execFileSync, spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The audit destination name is the runtime's own export, never a harness
// copy: one constant with one home, so a rename there moves every consumer
// with it instead of leaving a stale literal that still matches nothing.
import { AUDIT_FILE_NAME } from "../../.pi/extensions/ghjig/audit.ts";

export { AUDIT_FILE_NAME };

export type ScriptTurn =
	| { kind: "toolCall"; name: string; arguments: Record<string, unknown> }
	| { kind: "text"; text: string };

/**
 * A real git repository built inside the fixture root, for the arms that
 * measure what a ref **is** rather than how it is spelled (§3.11).
 *
 * Every git invocation the builder makes runs with an environment assembled
 * here — a fixture-owned global config file, `GIT_CONFIG_NOSYSTEM`, and a
 * fixture identity — so no property of the repository is inherited from the
 * host's git configuration, and nothing the builder does can write to the
 * host's own configuration (§4.7 host boundary; §3.12 no-false-red).
 */
export interface GitRepoOptions {
	/** Branch the seed commit lands on. Default `main`. */
	defaultBranch?: string;
	/** Extra branches created at the seed commit. */
	branches?: string[];
	/** `push.default` written to the repository's own config. */
	localPushDefault?: string;
	/** `push.default` written to the fixture-owned global config file. */
	globalPushDefault?: string;
	/**
	 * Point `origin` at a real bare repository inside the fixture instead of
	 * the placeholder URL. An arm that lets a push through then measures a
	 * push that actually completed, with no network in the picture at all —
	 * the fixture stays hermetic in both directions (§4.7).
	 */
	localOrigin?: boolean;
}

/** A linked worktree of a `GitRepo` — its own work tree and per-worktree gitdir. */
export interface LinkedWorktree {
	root: string;
	/** `<repo>/.git/worktrees/<name>` — holds this worktree's HEAD, and an empty `refs/`. */
	gitDir: string;
	branch: string;
}

export interface GitRepo {
	/** The primary work tree. */
	root: string;
	/** `<root>/.git`. */
	gitDir: string;
	defaultBranch: string;
	/** The fixture-owned file `GIT_CONFIG_GLOBAL` points at for this repository. */
	globalConfigFile: string;
	/** The hermetic environment every git invocation against this repository uses. */
	env: Record<string, string>;
	/** Runs git against this repository; throws on a non-zero status. */
	git(args: string[], cwd?: string): string;
	/** Runs git against this repository, reporting the outcome instead of throwing. */
	tryGit(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string };
	/** Path of the loose ref file for a fully-qualified ref name. */
	looseRefPath(ref: string): string;
	/** Writes `<aliasRef>` as a symbolic ref pointing at `<targetRef>`. */
	addSymrefAlias(aliasRef: string, targetRef: string): void;
	/** Hardlinks `<newRef>`'s loose ref file onto `<targetRef>`'s. */
	addHardlinkedRef(newRef: string, targetRef: string): void;
	/** Points HEAD at an arbitrary ref name, resolvable or not. */
	setHead(ref: string): void;
	/** Creates a branch at HEAD and switches to it. */
	switchToNewBranch(name: string): void;
	/** `git pack-refs --all` — moves every loose ref into `packed-refs`. */
	packRefs(): void;
	/** Deletes the `origin/HEAD` symref, leaving the remote and its branches. */
	removeOriginHead(): void;
	/** Adds a linked worktree under `<fixture>/worktrees/<name>`. */
	addWorktree(name: string, target: { checkout: string } | { newBranch: string }): LinkedWorktree;
	/**
	 * Whether this repository's filesystem folds ref-name case, measured by
	 * writing a loose ref and probing for its upper-cased path — never
	 * inferred from the platform name, which answers a different question.
	 */
	filesystemFoldsCase(): boolean;
}

export interface FixtureOptions {
	/** Deterministic provider turns, written to `<project>/script.json`. */
	script: ScriptTurn[];
	/** Build a real git repository at `<fixture>/repo` (see `GitRepoOptions`). */
	gitRepo?: GitRepoOptions;
	/**
	 * Where pi's project directory sits — the directory the session runs in
	 * and the only place pi looks for project extensions (`<cwd>/.pi/
	 * extensions/`, with no upward walk).
	 *
	 * `"fixtureRoot"` (default) keeps the layout the scaffold established.
	 * `"gitRepo"` puts `.pi/extensions/` and `script.json` inside the
	 * fixture's git repository, which is the only layout in which the
	 * session's own working directory is a repository a gate can measure.
	 */
	projectDir?: "fixtureRoot" | "gitRepo";
	/** Symlink this repository's `.pi/extensions/ghjig.ts` and `.pi/extensions/ghjig/` into the fixture. */
	linkGhjigRuntime?: boolean;
	/**
	 * Copy this repository's runtime into the fixture instead of linking it.
	 *
	 * The difference is not stylistic: the runtime self-locates from its own
	 * module realpath, so a LINKED runtime resolves its repository root — and
	 * therefore its operational state root — to THIS repository, while a
	 * COPIED one resolves both inside the fixture. A run with no state seam
	 * is only disposable under the copy (§5.5), which is why `runPi` refuses
	 * to combine an unseamed run with a linked runtime.
	 */
	copyGhjigRuntime?: boolean;
	/** Extra extension files to write, keyed by path relative to `<fixture>/.pi/extensions/`. */
	extensionFiles?: Record<string, string>;
	/** Extra extension symlinks to create, keyed by name relative to `<fixture>/.pi/extensions/`, value = absolute target. */
	extensionLinks?: Record<string, string>;
}

export interface Fixture {
	root: string;
	/** pi's working directory for this fixture — `<fixture>` or the git repository. */
	projectDir: string;
	extensionsDir: string;
	sessionsDir: string;
	/** The disposable state root the seam points at. */
	stateDir: string;
	homeDir: string;
	piAgentDir: string;
	/** Where the ghjig audit primitive is expected to write under the seam. */
	auditFile: string;
	/**
	 * True when the runtime under test is reached through a link into THIS
	 * repository's tree, which makes this repository the root it self-locates
	 * to. `runPi` reads it to keep an unseamed run off the operational sink.
	 */
	runtimeLinkedFromRepo: boolean;
	/** Present exactly when `FixtureOptions.gitRepo` was given. */
	gitRepo?: GitRepo;
}

export interface RunOptions {
	prompt?: string;
	/**
	 * Extra environment for the pi process (e.g. decoy variables). Overrides
	 * every variable of the hermetic base EXCEPT the state seam
	 * `GHJIG_TEST_STATE_ROOT` — see `seamOverride`.
	 */
	env?: Record<string, string>;
	/**
	 * Deliberate replacement of the single state seam (§4.6: exactly one
	 * documented override seam, marked test-only). This is the ONLY channel
	 * that can move the suite's state root off `<fixture>/state`, so an
	 * unusable-seam arm has to ask for it by name; `env` cannot reach the
	 * seam even by accident, which keeps every other run off the operational
	 * evidence surface (§5.5).
	 */
	seamOverride?: string;
	/**
	 * Run with NO state seam set at all — the resolution path a real session
	 * takes (§6 milestone condition 1: the runtime governing without any
	 * test-only machinery in it).
	 *
	 * Admissible only for a fixture whose runtime was copied, never linked:
	 * a linked runtime self-locates to this repository and would resolve its
	 * state root to the operational sink, which a suite must never write
	 * (§5.5). The combination is rejected here rather than documented as a
	 * caller precondition, so the mistake cannot be made silently.
	 */
	seamUnset?: boolean;
	timeoutMs?: number;
}

export interface PiRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Substrate version, logged per run (drift stays observable). */
	piVersion: string;
}

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/** This repository's root, resolved from the harness's own location — never from cwd or env. */
export function repoRoot(): string {
	return resolve(HARNESS_DIR, "..", "..");
}

/**
 * pi's load-time action-method failure class, calibrated against pi 0.84.3:
 * a violating extension aborts the run (non-zero exit) with this message on
 * stderr. The smoke test re-proves this per run (D1); if the substrate
 * drifts, the detector fails loud as "cannot measure" instead of going
 * silently blind (§3.9).
 */
export const LOAD_TIME_ACTION_FAILURE = /Action methods cannot be called during extension loading/;

export function isLoadTimeActionFailure(result: PiRunResult): boolean {
	return result.exitCode !== 0 && LOAD_TIME_ACTION_FAILURE.test(result.stderr);
}

/**
 * Builds the fixture git repository. Every path it touches — work tree,
 * worktrees, global config — sits under `fixtureRoot`, so `removeFixture`
 * disposes of all of it and no operational surface is ever a destination
 * (§5.5).
 */
function buildGitRepo(fixtureRoot: string, options: GitRepoOptions): GitRepo {
	const defaultBranch = options.defaultBranch ?? "main";
	const root = join(fixtureRoot, "repo");
	const gitDir = join(root, ".git");
	const globalConfigFile = join(fixtureRoot, "gitconfig");
	const worktreesDir = join(fixtureRoot, "worktrees");
	mkdirSync(root, { recursive: true });
	mkdirSync(worktreesDir, { recursive: true });
	writeFileSync(
		globalConfigFile,
		options.globalPushDefault === undefined ? "" : `[push]\n\tdefault = ${options.globalPushDefault}\n`,
	);

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: join(fixtureRoot, "home"),
		// The two variables that together close every host-configuration door:
		// the global config is a file this fixture owns and the system config
		// is not read at all. Without them a developer's own `~/.gitconfig`
		// (a `push.default`, an `init.defaultBranch`, a commit-signing setting)
		// would decide what the fixture is, and the arms would measure the host.
		GIT_CONFIG_GLOBAL: globalConfigFile,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "ghjig fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "ghjig fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_TERMINAL_PROMPT: "0",
		// git localizes its diagnostics; a fixture that reads them must read
		// one language, and an assertion never reads them at all.
		LC_ALL: "C",
	};

	const git = (args: string[], cwd: string = root): string =>
		execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
	const tryGit = (args: string[], cwd: string = root): { ok: boolean; stdout: string; stderr: string } => {
		try {
			return { ok: true, stdout: git(args, cwd), stderr: "" };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string };
			return { ok: false, stdout: String(failure.stdout ?? "").trim(), stderr: String(failure.stderr ?? "").trim() };
		}
	};
	const looseRefPath = (ref: string): string => join(gitDir, ...ref.split("/"));

	// The loose-ref-file backend is what the same-file identity arms measure;
	// ask for it explicitly rather than inheriting whatever this git version
	// happens to default to. A git that does not know the option still yields
	// its own default, and the calibration arm reports which backend was
	// actually built — an unmeasurable backend is visible, never assumed.
	if (!tryGit(["init", "--ref-format=files", "-q", "-b", defaultBranch, root], fixtureRoot).ok) {
		git(["init", "-q", "-b", defaultBranch, root], fixtureRoot);
	}
	git(["config", "user.name", "ghjig fixture"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "seed.txt"), "seed\n");
	git(["add", "seed.txt"]);
	git(["commit", "-q", "-m", "chore: seed the fixture repository"]);

	for (const branch of options.branches ?? []) {
		git(["branch", branch]);
	}
	// Every fixture repository carries a remote, its default-branch ref, and
	// the origin/HEAD pointer that names the default branch — the shape an
	// ordinary clone has. The repository that lacks the pointer is built by
	// removing it (`removeOriginHead`), which loses that one pointer and
	// nothing else, so an arm measuring the loss measures only the loss.
	const originUrl = options.localOrigin === true ? join(fixtureRoot, "origin.git") : "https://example.invalid/ghjig-fixture.git";
	if (options.localOrigin === true) {
		git(["init", "--bare", "-q", "-b", defaultBranch, originUrl], fixtureRoot);
	}
	git(["remote", "add", "origin", originUrl]);
	git(["update-ref", `refs/remotes/origin/${defaultBranch}`, git(["rev-parse", defaultBranch])]);
	git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`]);
	if (options.localPushDefault !== undefined) {
		git(["config", "push.default", options.localPushDefault]);
	}

	return {
		root,
		gitDir,
		defaultBranch,
		globalConfigFile,
		env,
		git,
		tryGit,
		looseRefPath,
		addSymrefAlias: (aliasRef, targetRef) => {
			git(["symbolic-ref", aliasRef, targetRef]);
		},
		addHardlinkedRef: (newRef, targetRef) => {
			linkSync(looseRefPath(targetRef), looseRefPath(newRef));
		},
		setHead: (ref) => {
			git(["symbolic-ref", "HEAD", ref]);
		},
		switchToNewBranch: (name) => {
			git(["switch", "-q", "-c", name]);
		},
		packRefs: () => {
			git(["pack-refs", "--all"]);
		},
		removeOriginHead: () => {
			git(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
		},
		addWorktree: (name, target) => {
			const worktreeRoot = join(worktreesDir, name);
			if ("newBranch" in target) {
				git(["worktree", "add", "-q", "-b", target.newBranch, worktreeRoot]);
				return { root: worktreeRoot, gitDir: join(gitDir, "worktrees", name), branch: target.newBranch };
			}
			git(["worktree", "add", "-q", worktreeRoot, target.checkout]);
			return { root: worktreeRoot, gitDir: join(gitDir, "worktrees", name), branch: target.checkout };
		},
		filesystemFoldsCase: () => {
			// Probe, never predicate on the platform name: case folding is a
			// property of the filesystem this repository sits on, and the same
			// platform hosts both kinds of filesystem.
			const headsDir = join(gitDir, "refs", "heads");
			mkdirSync(headsDir, { recursive: true });
			const probe = join(headsDir, "ghjig-case-probe");
			try {
				// Written from the default branch's own object id: the probe must
				// not depend on HEAD, which a caller may already have moved to
				// an unresolvable spelling.
				writeFileSync(probe, `${git(["rev-parse", `refs/heads/${defaultBranch}`])}\n`);
				return existsSync(join(headsDir, "GHJIG-CASE-PROBE"));
			} finally {
				rmSync(probe, { force: true });
			}
		},
	};
}

/**
 * Runs `fn` with the ambient git configuration of THIS process pinned to
 * `repo`'s fixture-owned files.
 *
 * The gate under test resolves git state in-process, so it reads the ambient
 * environment exactly as it would in a real session. Left alone, that
 * environment is the developer's: a host `~/.gitconfig` carrying
 * `push.default`, or a stray `GIT_DIR`, would decide arms that are supposed
 * to be measuring the fixture (§3.12 — a check that can false-red is a
 * defect). This is the one door that moves it, and it always restores.
 */
export function withRepoGitAmbient<T>(repo: GitRepo, fn: () => T): T {
	const managed = [
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_NOSYSTEM",
		"GIT_CONFIG_SYSTEM",
		"GIT_CONFIG_COUNT",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_CEILING_DIRECTORIES",
	];
	const saved: Record<string, string | undefined> = {};
	for (const name of managed) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.GIT_CONFIG_GLOBAL = repo.globalConfigFile;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	try {
		return fn();
	} finally {
		for (const name of managed) {
			if (saved[name] === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = saved[name];
			}
		}
	}
}

function writeScriptAt(projectDir: string, script: ScriptTurn[]): void {
	writeFileSync(join(projectDir, "script.json"), `${JSON.stringify(script, null, "\t")}\n`);
}

/**
 * Replaces a fixture's scripted turns after it exists.
 *
 * The arms that need this are the ones whose commands must name things the
 * fixture only owns once it has been built — a state root, a repository's
 * own default branch. Rebuilding the fixture to obtain them would leave the
 * first one behind; this keeps one fixture and one script location, which
 * stays knowledge of the harness rather than of a suite.
 */
export function writeScript(fixture: Fixture, script: ScriptTurn[]): void {
	writeScriptAt(fixture.projectDir, script);
}

export function buildFixture(options: FixtureOptions): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ghjig-fixture-"));
	// The repository is built first because it can BE the project directory:
	// a gate measures the session's own working directory, so the arms that
	// exercise one need `.pi/extensions/` to sit inside the repository.
	const gitRepo = options.gitRepo === undefined ? undefined : buildGitRepo(root, options.gitRepo);
	if (options.projectDir === "gitRepo" && gitRepo === undefined) {
		throw new Error("projectDir: \"gitRepo\" needs a gitRepo option — there is no repository to run in");
	}
	const projectDir = options.projectDir === "gitRepo" && gitRepo !== undefined ? gitRepo.root : root;
	const extensionsDir = join(projectDir, ".pi", "extensions");
	const sessionsDir = join(root, "sessions");
	const stateDir = join(root, "state");
	const homeDir = join(root, "home");
	const piAgentDir = join(root, "pi-agent");
	for (const dir of [extensionsDir, sessionsDir, stateDir, homeDir, piAgentDir]) {
		mkdirSync(dir, { recursive: true });
	}

	// Static committed provider, copied in as bytes (never imported by the
	// test process — only pi's loader can resolve its imports).
	writeFileSync(
		join(extensionsDir, "scripted-provider.ts"),
		readFileSync(join(HARNESS_DIR, "scripted-provider.ts"), "utf8"),
	);
	writeScriptAt(projectDir, options.script);

	if (options.copyGhjigRuntime) {
		// Copied, not linked: the loaded module's own realpath then sits inside
		// the fixture, so the runtime self-locates to the fixture's project
		// root and every root it derives from that stays disposable.
		cpSync(join(repoRoot(), ".pi", "extensions", "ghjig.ts"), join(extensionsDir, "ghjig.ts"));
		cpSync(join(repoRoot(), ".pi", "extensions", "ghjig"), join(extensionsDir, "ghjig"), { recursive: true });
	}

	if (options.linkGhjigRuntime) {
		// Fixture construction never verifies the link targets: a dangling
		// symlink is legal here by design. Whether the runtime is present is
		// measured by the suite's evidence assertions, never by the builder —
		// the harness lays out the shape, the assertions read the result.
		symlinkSync(join(repoRoot(), ".pi", "extensions", "ghjig.ts"), join(extensionsDir, "ghjig.ts"), "file");
		symlinkSync(join(repoRoot(), ".pi", "extensions", "ghjig"), join(extensionsDir, "ghjig"), "dir");
	}

	for (const [relPath, content] of Object.entries(options.extensionFiles ?? {})) {
		const target = join(extensionsDir, relPath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	for (const [name, target] of Object.entries(options.extensionLinks ?? {})) {
		symlinkSync(target, join(extensionsDir, name));
	}

	return {
		root,
		projectDir,
		extensionsDir,
		sessionsDir,
		stateDir,
		homeDir,
		piAgentDir,
		auditFile: join(stateDir, AUDIT_FILE_NAME),
		runtimeLinkedFromRepo: options.linkGhjigRuntime === true,
		gitRepo,
	};
}

export function removeFixture(fixture: Fixture): void {
	rmSync(fixture.root, { recursive: true, force: true });
}

export function runPi(fixture: Fixture, options: RunOptions = {}): Promise<PiRunResult> {
	if (options.seamUnset === true && fixture.runtimeLinkedFromRepo) {
		throw new Error(
			"an unseamed run needs a copied runtime: a linked runtime self-locates to this repository, " +
				"so the run would resolve its state root to the operational sink a suite must never write (§5.5)",
		);
	}
	const piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
	const args = [
		"-p",
		options.prompt ?? "run the script",
		"-a",
		"--session-dir",
		fixture.sessionsDir,
		"--provider",
		"scripted",
		"--model",
		"scripted-model",
	];
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: fixture.homeDir,
		PI_CODING_AGENT_DIR: fixture.piAgentDir,
		PI_OFFLINE: "1",
		...options.env,
	};
	// Bound AFTER the spread: `env` overrides everything else, but the one
	// variable that keeps this run off the operational state root is reachable
	// only through the explicit `seamOverride`/`seamUnset` opt-ins (§4.6, §5.5).
	if (options.seamUnset !== true) {
		env.GHJIG_TEST_STATE_ROOT = options.seamOverride ?? fixture.stateDir;
	} else {
		delete env.GHJIG_TEST_STATE_ROOT;
	}
	return new Promise((resolvePromise) => {
		// stdio[0] = "ignore" attaches /dev/null: the explicit end-of-input
		// the spike requires for headless runs.
		const child = spawn("pi", args, { cwd: fixture.projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs ?? 120_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ exitCode: code, stdout, stderr, timedOut, piVersion });
		});
	});
}

/** Every entry from every session JSONL under the fixture's session dir. */
export function readSessionEntries(fixture: Fixture): Array<Record<string, unknown>> {
	const entries: Array<Record<string, unknown>> = [];
	const walk = (dir: string): void => {
		for (const item of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, item.name);
			if (item.isDirectory()) {
				walk(full);
			} else if (item.name.endsWith(".jsonl")) {
				for (const line of readFileSync(full, "utf8").split("\n")) {
					if (line.trim() !== "") {
						entries.push(JSON.parse(line) as Record<string, unknown>);
					}
				}
			}
		}
	};
	if (existsSync(fixture.sessionsDir)) {
		walk(fixture.sessionsDir);
	}
	return entries;
}

/** Raw lines of the audit file under the fixture's seam root. */
export function readAuditLines(fixture: Fixture): string[] {
	return readFileSync(fixture.auditFile, "utf8").split("\n").filter((line) => line !== "");
}

/**
 * Raw lines of an audit file at an arbitrary path — empty when the file is
 * not there. Absence is a legitimate reading — nothing was recorded — so
 * a caller that wants to distinguish "no records" from "no sink" asserts on
 * the path itself; this reader never turns a missing sink into a throw.
 */
export function readAuditLinesAt(auditFile: string): string[] {
	if (!existsSync(auditFile)) {
		return [];
	}
	return readFileSync(auditFile, "utf8").split("\n").filter((line) => line !== "");
}

/** Sorted recursive listing (relative paths) — for zero-new-entries assertions. */
export function listTreeEntries(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string, prefix: string): void => {
		for (const item of readdirSync(current, { withFileTypes: true })) {
			const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
			found.push(rel);
			if (item.isDirectory()) {
				walk(join(current, item.name), rel);
			}
		}
	};
	walk(dir, "");
	return found.sort();
}

/** `git status --porcelain` of this repository — the D2 snapshot surface. */
export function gitPorcelain(): string {
	return execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot(), encoding: "utf8" });
}
