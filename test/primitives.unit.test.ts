/**
 * Unit suite for the tier-1 runtime primitives (issue #32).
 *
 * Imports the runtime modules from this repository's `.pi/extensions/ghjig/`
 * tree directly. Contracts under test:
 *
 *   - audit.ts    — one JSON object per line; free text encoded at write
 *                   time so embedded newlines/control characters never
 *                   split a record (§5.5); append to a missing destination
 *                   fails open without throwing (§3.9 posture row); the
 *                   sink is the path the consuming gate reads and nothing
 *                   else (§4.6), readable only by the account that writes
 *                   it (§5.5), and its degradation signal names a recovery
 *                   that is live where it is emitted (§3.11).
 *   - state-root.ts — resolution matrix: no seam → operational path
 *                   computed, nothing created; seam → override with
 *                   `seamActive: true`; malformed/unusable seam → refusal,
 *                   never a fallback to the operational sink (§5.5, §3.9).
 *   - locate.ts   — self-location from the installed module path: cwd-
 *                   independent for every entry (§4.6), immune to decoy
 *                   ambient variables (§4.6), bounded below by the install
 *                   root — decided component-wise, so a directory whose
 *                   name merely shares a prefix with the traversal token
 *                   is bounded like any other (§4.6, §4.7) — and answering
 *                   rather than throwing when the filesystem refuses a
 *                   probe (§3.9 `repo-root-discovery`).
 *   - postures.ts — the §3.9 fail-posture inventory: exactly the three
 *                   shipped dependencies, each with a posture, and every
 *                   fail-closed row with an in-place justification.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
// The sink's name comes from the runtime itself: an arm that plants a symlink
// or reads a mode has to address exactly the path the runtime appends to, so a
// rename there moves the arm with it instead of quietly aiming it elsewhere.
import { appendAuditRecord, AUDIT_FILE_NAME } from "../.pi/extensions/ghjig/audit.ts";
import { locateRepoRoot, locateRepoRootFrom } from "../.pi/extensions/ghjig/locate.ts";
import { POSTURES } from "../.pi/extensions/ghjig/postures.ts";
import { resolveStateRoot } from "../.pi/extensions/ghjig/state-root.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SEAM = "GHJIG_TEST_STATE_ROOT";
const DECOY_VARS = ["GHJIG_ROOT", "GHJIG_STATE_ROOT", "GHJIG_PI_ROOT", "PI_STATE_ROOT"] as const;
const MANAGED_VARS = [SEAM, ...DECOY_VARS];

let savedEnv: Record<string, string | undefined>;

/** Runs `fn` with console.warn captured — degradation signals are assertable evidence. */
function captureWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]): void => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		return { value: fn(), warnings };
	} finally {
		console.warn = original;
	}
}

beforeEach(() => {
	savedEnv = {};
	for (const name of MANAGED_VARS) {
		savedEnv[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(() => {
	for (const name of MANAGED_VARS) {
		if (savedEnv[name] === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = savedEnv[name];
		}
	}
});

describe("audit primitive: one-line encoded records (§5.5)", () => {
	const NASTY_TEXT = "line1\nline2\r\ttab and control \u0000\u001b[31m chars";
	let root: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "ghjig-audit-"));
		appendAuditRecord(root, { category: "test", action: "first", text: NASTY_TEXT });
		appendAuditRecord(root, { category: "test", action: "second", text: "plain" });
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	function auditLines(): string[] {
		return readFileSync(join(root, "audit.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line !== "");
	}

	it("writes to audit.jsonl under the given state root", () => {
		assert.ok(existsSync(join(root, "audit.jsonl")));
	});

	it("keeps one record per line despite embedded newlines in free text", () => {
		assert.equal(auditLines().length, 2);
	});

	it("emits every line as a standalone JSON object", () => {
		for (const line of auditLines()) {
			const parsed: unknown = JSON.parse(line);
			assert.equal(typeof parsed, "object");
		}
	});

	it("round-trips the free text intact", () => {
		const first = JSON.parse(auditLines()[0]) as { text: string };
		assert.equal(first.text, NASTY_TEXT);
	});

	it("stamps each record with timestamp, category, and action", () => {
		const record = JSON.parse(auditLines()[1]) as Record<string, unknown>;
		assert.ok(
			typeof record.timestamp === "string" &&
				record.timestamp !== "" &&
				record.category === "test" &&
				record.action === "second",
			`unexpected record shape: ${auditLines()[1]}`,
		);
	});

	it("fails open without throwing when the destination is missing (§3.9)", () => {
		const missing = join(root, "no-such-dir", "deeper");
		let outcome = true;
		assert.doesNotThrow(() => {
			outcome = captureWarnings(() =>
				appendAuditRecord(missing, { category: "test", action: "degrade", text: "x" }),
			).value;
		});
		assert.equal(outcome, false, "a failed append must report failure, not success");
	});

	it("says plainly that nothing is being recorded when the append degrades open (§3.9)", () => {
		const missing = join(root, "no-such-dir", "deeper");
		const { warnings } = captureWarnings(() =>
			appendAuditRecord(missing, { category: "test", action: "degrade", text: "x" }),
		);
		assert.equal(warnings.length, 1, `expected one degradation warning, got ${JSON.stringify(warnings)}`);
		assert.match(warnings[0], /no audit evidence is being recorded/);
		assert.match(warnings[0], /NOT ENFORCED/);
	});
});

describe("audit primitive: the sink is the path the gate reads (§4.6, §5.5)", () => {
	const INPUT = { category: "test", action: "sink", text: "evidence" };

	/** The recovery clause of a degradation signal, if the signal carries one. */
	function recoveryClause(warning: string): string | undefined {
		return /Recovery:\s*(.+)$/s.exec(warning)?.[1];
	}

	/**
	 * The directory a recovery clause tells the operator to create. The arm
	 * that runs the recovery needs one machine-readable handle on it: an
	 * absolute path in the clause, either the destination directory itself or
	 * the sink file inside it. Absolute-path shape is POSIX here; a host with
	 * another path grammar needs this reader widened, not the contract.
	 */
	function destinationNamedIn(clause: string): string | undefined {
		const found = /(\/[^\s'"`]+)/.exec(clause)?.[1];
		if (found === undefined) {
			return undefined;
		}
		const path = found.replace(/[.,;:)'"`]+$/, "");
		return path.endsWith(`/${AUDIT_FILE_NAME}`) ? dirname(path) : path;
	}

	it("leaves a symlink's target untouched: the record lands at the audit path itself (§4.6)", () => {
		// Write-target equals read-target: a link planted at the sink path must
		// not send the evidence somewhere the consuming gate never reads.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-link-"));
		try {
			const elsewhere = join(stateRoot, "elsewhere");
			mkdirSync(elsewhere);
			const target = join(elsewhere, "captured.log");
			writeFileSync(target, "");
			symlinkSync(target, join(stateRoot, AUDIT_FILE_NAME));
			captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			assert.equal(
				readFileSync(target, "utf8"),
				"",
				"the audit record was written through the symlink into its target: the evidence sink is redirectable",
			);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("creates the sink readable only by the account that writes it (§5.5)", {
		// POSIX permission bits. On a host that does not carry them the mode
		// says nothing about who may read the file, so the arm measures nothing
		// rather than reporting a result it cannot support.
		skip: process.platform === "win32" ? "POSIX permission bits" : false,
	}, () => {
		// The umask is normalised to 0 for the measurement. Left at the host's
		// default this arm would pass on any machine whose umask already masks
		// group and other, without the writer ever declaring a mode — the
		// vacuous pass the mode contract exists to rule out.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-mode-"));
		const savedUmask = process.umask(0o000);
		try {
			appendAuditRecord(stateRoot, INPUT);
			assert.equal(
				(statSync(join(stateRoot, AUDIT_FILE_NAME)).mode & 0o777).toString(8),
				"600",
				"the audit sink is created under the ambient umask: an audit record names what a repository's work touched, and a host may carry accounts that work never concerned",
			);
		} finally {
			process.umask(savedUmask);
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("names a recovery in the degraded-append signal (§3.11)", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-signal-"));
		try {
			const { warnings } = captureWarnings(() =>
				appendAuditRecord(join(stateRoot, "no-such-dir", "deeper"), INPUT),
			);
			assert.ok(
				recoveryClause(warnings[0] ?? "") !== undefined,
				`the degradation signal states cause and consequence but no way to restore the trail: ${JSON.stringify(warnings)}`,
			);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("names a recovery that is live at this surface: performing it restores the trail (§3.11)", () => {
		// Asserted by running the recovery, not by matching its prose: the arm
		// creates the destination the signal names and appends again. A signal
		// naming a recovery that does not restore the trail is worse than one
		// naming none.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-recovery-"));
		try {
			const missing = join(stateRoot, "no-such-dir", "deeper");
			const { warnings } = captureWarnings(() => appendAuditRecord(missing, INPUT));
			const clause = recoveryClause(warnings[0] ?? "");
			const destination = clause === undefined ? undefined : destinationNamedIn(clause);
			if (destination !== undefined) {
				mkdirSync(destination, { recursive: true });
			}
			const restored = captureWarnings(() => appendAuditRecord(missing, INPUT)).value;
			assert.equal(
				restored,
				true,
				`following the recovery the signal named did not restore the audit trail. signal: ${JSON.stringify(warnings[0])}; recovery clause: ${JSON.stringify(clause)}; destination created: ${JSON.stringify(destination)}`,
			);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});

describe("state-root resolution matrix (§5.5, §4.6)", () => {
	it("computes the operational path under the repo root when no seam is set", () => {
		const resolved = resolveStateRoot();
		assert.deepEqual(resolved, { root: join(REPO_ROOT, ".ghjig", "state"), seamActive: false });
	});

	it("creates nothing when no seam is set (resolution only, no operational-root creation)", () => {
		const operational = join(REPO_ROOT, ".ghjig", "state");
		const existedBefore = existsSync(operational);
		resolveStateRoot();
		assert.equal(existsSync(operational), existedBefore);
	});

	it("returns the seam target with seamActive: true when the seam is set", () => {
		const seamDir = mkdtempSync(join(tmpdir(), "ghjig-seam-"));
		try {
			process.env[SEAM] = seamDir;
			assert.deepEqual(resolveStateRoot(), { root: seamDir, seamActive: true });
		} finally {
			rmSync(seamDir, { recursive: true, force: true });
		}
	});

	it("refuses a malformed seam (relative path) instead of falling back", () => {
		process.env[SEAM] = "relative/state-root";
		assert.throws(() => resolveStateRoot());
	});

	it("refuses an empty seam instead of selecting the operational root (§3.9)", () => {
		// Set-but-empty is present-and-unmeasurable, not unset: the fail-closed
		// arm owns it, or a test context silently writes the operational sink.
		process.env[SEAM] = "";
		assert.throws(
			() => resolveStateRoot(),
			/is set but not an absolute path \(empty value\)/,
			"an empty seam must refuse, not fall back to the operational state root",
		);
	});

	it("names a live recovery in every refusal message (§3.11)", () => {
		const recovery = new RegExp(
			`Recovery: unset ${SEAM} to use the operational state root, ` +
				`or point it at an existing absolute directory\\.`,
		);
		process.env[SEAM] = "relative/state-root";
		assert.throws(() => resolveStateRoot(), recovery, "the relative-seam arm prescribes no fix");
		process.env[SEAM] = join(tmpdir(), "ghjig-no-such-seam-target");
		assert.throws(() => resolveStateRoot(), recovery, "the missing-target arm prescribes no fix");
	});

	it("refuses an unusable seam target (existing regular file) instead of falling back", () => {
		const seamDir = mkdtempSync(join(tmpdir(), "ghjig-seam-"));
		const filePath = join(seamDir, "a-file");
		writeFileSync(filePath, "not a directory");
		try {
			process.env[SEAM] = filePath;
			assert.throws(() => resolveStateRoot());
		} finally {
			rmSync(seamDir, { recursive: true, force: true });
		}
	});

	it("creates nothing under the operational root on a refusal", () => {
		const operational = join(REPO_ROOT, ".ghjig", "state");
		const existedBefore = existsSync(operational);
		process.env[SEAM] = "relative/state-root";
		try {
			resolveStateRoot();
		} catch {
			// the refusal itself is asserted in the previous test
		}
		assert.equal(existsSync(operational), existedBefore);
	});
});

describe("locate: cwd-independence and decoy-env immunity (§4.6)", () => {
	function buildDecoyTree(): string {
		const decoy = mkdtempSync(join(tmpdir(), "ghjig-decoy-"));
		mkdirSync(join(decoy, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(decoy, ".ghjig", "state"), { recursive: true });
		writeFileSync(join(decoy, ".pi", "extensions", "look-alike.ts"), "// decoy\n");
		return decoy;
	}

	it("locates this repository's root from the installed module path", () => {
		assert.equal(locateRepoRoot(), REPO_ROOT);
	});

	it("returns an absolute path", () => {
		assert.ok(isAbsolute(locateRepoRoot()));
	});

	it("resolution is cwd-independent", () => {
		const decoy = buildDecoyTree();
		const originalCwd = process.cwd();
		try {
			process.chdir(decoy);
			assert.equal(locateRepoRoot(), REPO_ROOT);
		} finally {
			process.chdir(originalCwd);
			rmSync(decoy, { recursive: true, force: true });
		}
	});

	it("locateRepoRoot ignores decoy ambient variables", () => {
		const decoy = buildDecoyTree();
		try {
			for (const name of DECOY_VARS) {
				process.env[name] = decoy;
			}
			assert.equal(locateRepoRoot(), REPO_ROOT);
		} finally {
			rmSync(decoy, { recursive: true, force: true });
		}
	});

	it("resolveStateRoot ignores decoy ambient variables (only the named seam is read)", () => {
		const decoy = buildDecoyTree();
		try {
			for (const name of DECOY_VARS) {
				process.env[name] = decoy;
			}
			assert.deepEqual(resolveStateRoot(), {
				root: join(REPO_ROOT, ".ghjig", "state"),
				seamActive: false,
			});
		} finally {
			rmSync(decoy, { recursive: true, force: true });
		}
	});
});

describe("locate: candidate admissibility bound (§4.7)", () => {
	/** Lays out an install shape `<root>/<prefix>/.pi/extensions/ghjig/locate.ts`. */
	function installTree(prefix: string): { root: string; moduleFile: string; installDir: string } {
		const root = mkdtempSync(join(tmpdir(), "ghjig-install-"));
		const installDir = join(root, prefix, ".pi", "extensions", "ghjig");
		mkdirSync(installDir, { recursive: true });
		const moduleFile = join(installDir, "locate.ts");
		writeFileSync(moduleFile, "// stand-in for the installed module\n");
		return { root, moduleFile, installDir };
	}

	it("rejects a .pi/ directory below the install root and keeps walking", () => {
		const { root, moduleFile, installDir } = installTree(".");
		try {
			// One empty, git-invisible directory is the whole attack: without the
			// bound it becomes the repository root and the evidence sink moves.
			mkdirSync(join(installDir, ".pi"));
			const { value, warnings } = captureWarnings(() => locateRepoRootFrom(moduleFile));
			assert.equal(value, root, "a .pi/ below the install root must never be adopted as the repo root");
			assert.equal(warnings.length, 1, `expected one rejection warning, got ${JSON.stringify(warnings)}`);
			assert.match(warnings[0], /it sits below the install root/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a .pi/ below the install root whose directory name begins with the traversal token", () => {
		// `..z` is an ordinary directory name that merely shares a prefix with
		// `..`. Below the install root it is the same subproject candidate the
		// bound rejects under any other name, and adopting it relocates the
		// evidence sink into the install tree — the outcome the bound exists to
		// prevent (§4.7), reached through the prefix collision §4.6 forbids
		// from mis-scoping in either direction.
		const root = mkdtempSync(join(tmpdir(), "ghjig-install-"));
		try {
			mkdirSync(join(root, ".pi"));
			const below = join(root, "..z");
			mkdirSync(join(below, ".pi"), { recursive: true });
			// Three levels below <root>, so the structural root is <root> and
			// `<root>/..z` sits strictly inside it.
			const installDir = join(below, "nested", "install");
			mkdirSync(installDir, { recursive: true });
			const moduleFile = join(installDir, "locate.ts");
			writeFileSync(moduleFile, "// stand-in for the installed module\n");
			assert.equal(
				captureWarnings(() => locateRepoRootFrom(moduleFile)).value,
				root,
				"a .pi/ below the install root must never be adopted as the repo root, whatever its directory is named",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("still accepts a .pi/ ancestor above the install root (upper bound unmoved)", () => {
		const root = mkdtempSync(join(tmpdir(), "ghjig-install-"));
		try {
			mkdirSync(join(root, ".pi"));
			const deep = join(root, "x", "nested", "a", "b");
			mkdirSync(deep, { recursive: true });
			const moduleFile = join(deep, "locate.ts");
			writeFileSync(moduleFile, "// stand-in for the installed module\n");
			// structuralRoot is <root>/x; the only .pi/ sits one level higher.
			assert.equal(captureWarnings(() => locateRepoRootFrom(moduleFile)).value, root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("degrades open to the structural root when no admissible .pi/ ancestor exists (§3.9)", () => {
		const root = mkdtempSync(join(tmpdir(), "ghjig-install-"));
		try {
			const deep = join(root, "x", "nested", "a", "b");
			mkdirSync(deep, { recursive: true });
			const moduleFile = join(deep, "locate.ts");
			writeFileSync(moduleFile, "// stand-in for the installed module\n");
			const { value, warnings } = captureWarnings(() => locateRepoRootFrom(moduleFile));
			assert.equal(value, join(root, "x"), "the structural root the install layout implies");
			assert.equal(warnings.length, 1, `expected one degradation warning, got ${JSON.stringify(warnings)}`);
			assert.match(warnings[0], /repo-root discovery failed/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("locate: every entry resolves without the working directory (§4.6)", () => {
	/** The outcome of one resolution, compared across working directories. */
	type Outcome = { root: string } | { refused: true };

	function resolveFrom(cwd: string, moduleFile: string): Outcome {
		const originalCwd = process.cwd();
		process.chdir(cwd);
		try {
			return { root: captureWarnings(() => locateRepoRootFrom(moduleFile)).value };
		} catch {
			// A refusal is a legitimate answer to an argument the module cannot
			// anchor; what it must not be is a different answer per directory.
			return { refused: true };
		} finally {
			process.chdir(originalCwd);
		}
	}

	it("answers one argument identically from every working directory", () => {
		// The module states it never consults the process working directory. A
		// relative `moduleFile` is the entry where that can break: whatever the
		// resolution makes of such an argument, it must make the same of it
		// wherever the process happens to stand.
		const root = mkdtempSync(join(tmpdir(), "ghjig-cwd-"));
		try {
			const installDir = join(root, "x", "nested", "install");
			mkdirSync(installDir, { recursive: true });
			mkdirSync(join(root, "x", ".pi"), { recursive: true });
			writeFileSync(join(installDir, "locate.ts"), "// stand-in for the installed module\n");
			assert.deepEqual(
				resolveFrom(installDir, "locate.ts"),
				resolveFrom(join(root, "x"), "locate.ts"),
				"the same module argument resolved to different repository roots from two working directories",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("locate: probes answer rather than throw (§3.9 repo-root-discovery)", () => {
	it("returns a root when the filesystem refuses a probe on the walk", () => {
		// `repo-root-discovery` is an open posture and the resolution runs
		// inside the extension factory, so a throw here does not degrade the
		// walk — it aborts extension load, the fail-closed outcome that row
		// denies.
		//
		// Reach: this arm stages the refusal POSIX permissions can stage. It
		// measures nothing on a host that grants access regardless of mode (a
		// root container, or a filesystem without permission bits), and it
		// cannot stage a refusal that arrives BETWEEN two probes of the same
		// path — that one is a race, not a state a check can construct.
		const root = mkdtempSync(join(tmpdir(), "ghjig-refuse-"));
		const blocked = join(root, "blocked");
		const installDir = join(blocked, "nested", "install");
		mkdirSync(installDir, { recursive: true });
		mkdirSync(join(blocked, ".pi"));
		chmodSync(blocked, 0o000);
		try {
			assert.doesNotThrow(() =>
				captureWarnings(() => locateRepoRootFrom(join(installDir, "locate.ts"))),
			);
		} finally {
			chmodSync(blocked, 0o755);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("fail-posture inventory (§3.9)", () => {
	it("declares exactly the three shipped dependencies", () => {
		assert.deepEqual(
			POSTURES.map((row) => row.dependency).sort(),
			["audit-append", "repo-root-discovery", "seam-target"],
		);
	});

	it("keys each row on a failure shape, not a component", () => {
		for (const row of POSTURES) {
			assert.ok(
				typeof row.failureShape === "string" && row.failureShape.trim() !== "",
				`row ${row.dependency} lacks a failure shape`,
			);
		}
	});

	it("fails open on missing repo-root discovery and audit append", () => {
		for (const dependency of ["repo-root-discovery", "audit-append"]) {
			const row = POSTURES.find((candidate) => candidate.dependency === dependency);
			assert.equal(row?.posture, "open", `posture for ${dependency}`);
		}
	});

	it("fails closed on an unusable seam target", () => {
		const row = POSTURES.find((candidate) => candidate.dependency === "seam-target");
		assert.equal(row?.posture, "closed");
	});

	it("carries a non-empty in-place justification on every fail-closed row", () => {
		for (const row of POSTURES) {
			if (row.posture === "closed") {
				assert.ok(
					typeof row.justification === "string" && row.justification.trim() !== "",
					`fail-closed row ${row.dependency} lacks a justification`,
				);
			}
		}
	});
});
