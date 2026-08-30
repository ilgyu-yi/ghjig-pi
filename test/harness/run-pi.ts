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
 * The ghjig runtime under test is linked from THIS repository's tree
 * (`.pi/extensions/ghjig.ts` + `.pi/extensions/ghjig/`) into the fixture,
 * so the suite exercises the committed bytes, not a copy.
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
	existsSync,
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

export type ScriptTurn =
	| { kind: "toolCall"; name: string; arguments: Record<string, unknown> }
	| { kind: "text"; text: string };

export interface FixtureOptions {
	/** Deterministic provider turns, written to `<fixture>/script.json`. */
	script: ScriptTurn[];
	/** Symlink this repository's `.pi/extensions/ghjig.ts` and `.pi/extensions/ghjig/` into the fixture. */
	linkGhjigRuntime?: boolean;
	/** Extra extension files to write, keyed by path relative to `<fixture>/.pi/extensions/`. */
	extensionFiles?: Record<string, string>;
	/** Extra extension symlinks to create, keyed by name relative to `<fixture>/.pi/extensions/`, value = absolute target. */
	extensionLinks?: Record<string, string>;
}

export interface Fixture {
	root: string;
	extensionsDir: string;
	sessionsDir: string;
	/** The disposable state root the seam points at. */
	stateDir: string;
	homeDir: string;
	piAgentDir: string;
	/** Where the ghjig audit primitive is expected to write under the seam. */
	auditFile: string;
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

/** The audit file name the runtime and the suites agree on (SPEC §5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

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

export function buildFixture(options: FixtureOptions): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ghjig-fixture-"));
	const extensionsDir = join(root, ".pi", "extensions");
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
	writeFileSync(join(root, "script.json"), `${JSON.stringify(options.script, null, "\t")}\n`);

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
		extensionsDir,
		sessionsDir,
		stateDir,
		homeDir,
		piAgentDir,
		auditFile: join(stateDir, AUDIT_FILE_NAME),
	};
}

export function removeFixture(fixture: Fixture): void {
	rmSync(fixture.root, { recursive: true, force: true });
}

export function runPi(fixture: Fixture, options: RunOptions = {}): Promise<PiRunResult> {
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
		// Bound AFTER the spread: `env` overrides everything else, but the one
		// variable that keeps this run off the operational state root is
		// reachable only through the explicit `seamOverride` opt-in (§4.6, §5.5).
		GHJIG_TEST_STATE_ROOT: options.seamOverride ?? fixture.stateDir,
	};
	return new Promise((resolvePromise) => {
		// stdio[0] = "ignore" attaches /dev/null: the explicit end-of-input
		// the spike requires for headless runs.
		const child = spawn("pi", args, { cwd: fixture.root, env, stdio: ["ignore", "pipe", "pipe"] });
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
