/**
 * Unit suite for the tier-1 runtime primitives (issue #32).
 *
 * Imports the runtime modules from this repository's `.pi/extensions/ghjig/`
 * tree directly. Contracts under test:
 *
 *   - audit.ts    — one JSON object per line; free text encoded at write
 *                   time so embedded newlines/control characters never
 *                   split a record (§5.5); append to a missing destination
 *                   fails open without throwing (§3.9 posture row); and the
 *                   destination itself is the one the reader reads — a
 *                   symlink at the audit path never redirects the write,
 *                   the sink is created restrictively, and each failure
 *                   shape names the recovery live for it (§4.6, §3.11).
 *   - state-root.ts — resolution matrix: no seam → operational path
 *                   computed, nothing created; seam → override with
 *                   `seamActive: true`; malformed/unusable seam → refusal,
 *                   never a fallback to the operational sink (§5.5, §3.9);
 *                   an admissible seam target sits OUTSIDE the governed
 *                   repository, and creation is a separate, explicit act
 *                   that excludes what it creates from version control at
 *                   creation (§4.7).
 *   - locate.ts   — self-location from the installed module path: cwd-
 *                   independent for every entry point and for every
 *                   argument shape, immune to decoy ambient variables
 *                   (§4.6), bounded below by the install root so a `.pi/`
 *                   inside the install tree can never become the
 *                   repository root — read component-wise, so a directory
 *                   whose name merely begins with `..` is still a
 *                   descendant (§4.7) — and returning rather than throwing
 *                   on every probe failure, because a throw out of the
 *                   extension factory would contradict the declared open
 *                   posture (§3.9).
 *   - postures.ts — the §3.9 fail-posture inventory: one row per
 *                   dependency the runtime consults, machine-checked
 *                   against the runtime tree's own call sites (§6.1), each
 *                   fail-closed row justified in place, each fail-open row
 *                   saying "not enforced" plainly, and the accessor
 *                   refusing an unknown key at CALL time, never at module
 *                   load.
 *   - residuals.ts — the unmodelled-bypass enumeration (§3.11): a
 *                   different table with a disjoint key set, carrying no
 *                   posture and no fail direction, so it can never be read
 *                   as a second posture inventory.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { appendAuditRecord, AUDIT_FILE_NAME } from "../.pi/extensions/ghjig/audit.ts";
import { locateRepoRoot, locateRepoRootFrom } from "../.pi/extensions/ghjig/locate.ts";
import { POSTURES } from "../.pi/extensions/ghjig/postures.ts";
import { resolveStateRoot } from "../.pi/extensions/ghjig/state-root.ts";
import { buildFixture, type Fixture, type GitRepo, listTreeEntries, removeFixture } from "./harness/run-pi.ts";

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

/**
 * A disposable tree whose path is already canonical.
 *
 * The temp directory is reached through a symlink on some platforms, so a
 * fixture that keeps the unresolved spelling compares a runtime answer that
 * may legitimately be canonical against a path that is not — a red that is
 * not a defect (§3.12). Resolving once, here, removes the question.
 */
function disposableTree(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Modules whose exports this Execution adds are loaded INSIDE the arm that
 * needs them, so a missing module or a missing export is reported by that
 * arm rather than erasing the whole file's results.
 */
interface PostureRowShape {
	dependency: string;
	failureShape: string;
	posture: "open" | "closed";
	justification: string;
	degradationSignal?: string;
}
interface PostureModule {
	POSTURES: readonly PostureRowShape[];
	/** Accessor into the one inventory — resolves a key to its row. */
	posture(key: string): PostureRowShape;
}
interface ResidualEntry {
	vector: string;
	reason: string;
	homedAt: string;
	[key: string]: unknown;
}
interface StateRootModule {
	/** Creates the state root and everything the runtime keeps under it. */
	ensureStateRoot(root: string): unknown;
}

async function postureModule(): Promise<PostureModule> {
	return (await import("../.pi/extensions/ghjig/postures.ts")) as unknown as PostureModule;
}

async function residuals(): Promise<readonly ResidualEntry[]> {
	const module = (await import("../.pi/extensions/ghjig/residuals.ts")) as unknown as {
		RESIDUALS: readonly ResidualEntry[];
	};
	return module.RESIDUALS;
}

async function ensureStateRoot(root: string): Promise<void> {
	const module = (await import("../.pi/extensions/ghjig/state-root.ts")) as unknown as StateRootModule;
	module.ensureStateRoot(root);
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

	// The destination is read back through the runtime's own exported name,
	// so the assertion follows a rename instead of silently measuring a file
	// nothing writes any more.
	function auditLines(): string[] {
		return readFileSync(join(root, AUDIT_FILE_NAME), "utf8")
			.split("\n")
			.filter((line) => line !== "");
	}

	it("writes the audit file under the given state root", () => {
		assert.ok(existsSync(join(root, AUDIT_FILE_NAME)));
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

describe("audit destination integrity (§4.6, §3.11, AC8)", () => {
	/**
	 * The bytes of a file that is NOT the audit sink. A symlink at the audit
	 * path points here, so "the write did not follow the link" is measured on
	 * the link's target rather than on the link — §4.6's divergence, where the
	 * write succeeds, the read finds nothing, and both report clean.
	 */
	const VICTIM_CONTENT = "ORIGINAL-CONTENT-OF-A-FILE-THE-AUDIT-SINK-IS-NOT\n";
	let root: string;

	before(() => {
		root = disposableTree("ghjig-audit-dest-");
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	/** A state root whose audit path is a symlink onto a file outside it. */
	function symlinkedDestination(name: string): { stateRoot: string; victim: string } {
		const stateRoot = join(root, name);
		mkdirSync(stateRoot, { recursive: true });
		const victim = join(root, `${name}-victim`);
		writeFileSync(victim, VICTIM_CONTENT);
		symlinkSync(victim, join(stateRoot, AUDIT_FILE_NAME));
		return { stateRoot, victim };
	}

	function appendTo(stateRoot: string): { value: boolean; warnings: string[] } {
		return captureWarnings(() =>
			appendAuditRecord(stateRoot, { category: "test", action: "destination", text: "x" }),
		);
	}

	it("a symlink at the audit path does not redirect the write (§4.6)", () => {
		const { stateRoot, victim } = symlinkedDestination("linked-write");
		appendTo(stateRoot);
		assert.equal(
			readFileSync(victim, "utf8"),
			VICTIM_CONTENT,
			"the append followed a link out of the state root: the write target is no longer the read target",
		);
	});

	it("reports the refused write as a failed append, not as a success", () => {
		const { stateRoot } = symlinkedDestination("linked-outcome");
		assert.equal(appendTo(stateRoot).value, false);
	});

	it("degrades open on a symlinked destination — never throws (§3.9)", () => {
		const { stateRoot } = symlinkedDestination("linked-open");
		assert.doesNotThrow(() => appendTo(stateRoot));
	});

	it("creates the sink with a restrictive mode (§4.6)", () => {
		// Measured under a zeroed umask, so the arm reads what the runtime asks
		// for rather than what the host's umask happens to grant: a strict host
		// would otherwise pass this vacuously and a permissive one fail it for a
		// reason that is not the runtime's (§3.12).
		const stateRoot = join(root, "mode-probe");
		mkdirSync(stateRoot, { recursive: true });
		const savedUmask = process.umask(0o000);
		try {
			appendTo(stateRoot);
			assert.equal((statSync(join(stateRoot, AUDIT_FILE_NAME)).mode & 0o777).toString(8), "600");
		} finally {
			process.umask(savedUmask);
		}
	});

	it("gives the two failure shapes two different messages (§3.11)", () => {
		// "The destination is not a destination" and "there is no destination"
		// have different remedies; one shared string names the wrong one for
		// half its readers. Both shapes must have SPOKEN, or the difference is
		// the difference between a message and a silence.
		const { stateRoot } = symlinkedDestination("two-shapes");
		const linked = appendTo(stateRoot).warnings.join("\n");
		const missing = appendTo(join(root, "no-such-dir", "deeper")).warnings.join("\n");
		assert.ok(
			linked !== "" && missing !== "" && linked !== missing,
			`linked=${JSON.stringify(linked)} missing=${JSON.stringify(missing)}`,
		);
	});

	it("names the recovery that is live for a symlinked destination (§3.11)", () => {
		// Live here means: it names the link. Prescribing "create the directory"
		// at this arm would name a recovery that is dead — the directory exists.
		const { stateRoot } = symlinkedDestination("linked-recovery");
		const warning = appendTo(stateRoot).warnings.join("\n");
		assert.ok(/Recovery:/.test(warning) && /link/i.test(warning), `warning: ${JSON.stringify(warning)}`);
	});

	it("names the recovery that is live for a missing destination (§3.11)", () => {
		const warning = appendTo(join(root, "still-no-such-dir", "deeper")).warnings.join("\n");
		assert.ok(/Recovery:/.test(warning) && /director/i.test(warning), `warning: ${JSON.stringify(warning)}`);
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

	it("creates nothing inside an admissible seam target either — resolution only", () => {
		// The purity that lets every other arm reason about creation: resolving
		// a perfectly good seam is still not a write. Creation is a separate,
		// named act (`ensureStateRoot`), so a caller that only resolves cannot
		// leave a directory behind (§5.5).
		const seamDir = disposableTree("ghjig-seam-");
		try {
			process.env[SEAM] = seamDir;
			resolveStateRoot();
			assert.deepEqual(listTreeEntries(seamDir), []);
		} finally {
			rmSync(seamDir, { recursive: true, force: true });
		}
	});
});

describe("the seam's admissible-target policy (§5.5, §4.6, AC7)", () => {
	/**
	 * The policy this Execution decides and these arms enforce: an admissible
	 * seam target is an absolute, existing directory that is NEITHER the
	 * governed repository root NOR a strict descendant of it.
	 *
	 * The reason is this Execution's own: the shell's own evidence lands
	 * under the state root, so a root that can be pointed anywhere inside the
	 * tree the shell governs writes that surface into the very tree it
	 * observes, and a test-only seam has no business naming a directory of
	 * the repository under governance (§5.5's disposable-root carve-out).
	 * The refusals below name a DIFFERENT recovery
	 * from the unusable-target refusals, because "point it at an existing
	 * absolute directory" is dead advice for a target that is exactly that
	 * (§3.11).
	 *
	 * Nothing here writes: `resolveStateRoot` creates nothing on either arm,
	 * and every admissible target these arms use is disposable.
	 */
	/**
	 * A directory inside the governed tree, named as the directory THIS file
	 * sits in: it exists whenever this arm runs, and it moves with the suite
	 * instead of pointing at a path a later layout change can empty out.
	 */
	const governedDirectory = resolve(fileURLToPath(import.meta.url), "..");

	/** The message a refusal carried, or the empty string if it did not refuse. */
	function refusalMessage(seam: string): string {
		process.env[SEAM] = seam;
		try {
			resolveStateRoot();
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	it("refuses a target inside the governed repository", () => {
		assert.notEqual(
			refusalMessage(governedDirectory),
			"",
			"a directory of the repository under governance was admitted as the state root",
		);
	});

	it("refuses the governed repository root itself", () => {
		assert.notEqual(refusalMessage(REPO_ROOT), "");
	});

	it("compares resolved physical paths, not spellings (§4.6)", () => {
		// A link that sits outside the tree and lands inside it is the same
		// target by any measurement that resolves before it compares.
		const outside = disposableTree("ghjig-seam-link-");
		const link = join(outside, "into-the-governed-tree");
		try {
			symlinkSync(governedDirectory, link, "dir");
			assert.notEqual(refusalMessage(link), "");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("admits a target outside the governed repository", () => {
		const outside = disposableTree("ghjig-seam-outside-");
		try {
			process.env[SEAM] = outside;
			assert.deepEqual(resolveStateRoot(), { root: outside, seamActive: true });
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses the in-tree target with a different message than an unusable one (§3.11)", () => {
		// Both arms must actually refuse: a silence differs from a message
		// without being a second message, and §3.11 asks for two of the latter.
		const unusable = refusalMessage(join(tmpdir(), "ghjig-no-such-seam-target"));
		const inTree = refusalMessage(governedDirectory);
		assert.ok(
			inTree !== "" && unusable !== "" && inTree !== unusable,
			`in-tree=${JSON.stringify(inTree)} unusable=${JSON.stringify(unusable)}`,
		);
	});

	it("names the recovery that is live for an in-tree target (§3.11)", () => {
		// The generic recovery — "point it at an existing absolute directory" —
		// is dead here: the target already is one. What is live is the exclusion
		// the policy adds, so the message has to name it.
		assert.match(refusalMessage(governedDirectory), /outside/i);
	});

	it("records the policy in the module's own docstring (AC7)", () => {
		// The decision is recorded where §4.6 keeps the contract, and the record
		// is read from the file rather than from prose about the file, so it
		// cannot drift silently away from the behaviour above.
		const source = readFileSync(join(REPO_ROOT, ".pi", "extensions", "ghjig", "state-root.ts"), "utf8");
		const docstring = source.slice(0, source.indexOf("*/"));
		assert.ok(
			/governed/i.test(docstring) && /(descendant|inside|within|under)/i.test(docstring),
			`the module docstring does not state the admissible-target policy:\n${docstring}`,
		);
	});

	it("keys the seam-target posture row on the exclusion too (AC7)", () => {
		// The governed-tree exclusion is a refusal shape of its own, alongside
		// the unusable-value ones the row already keys on. A refusal shape with
		// no row is a posture nobody declared (§3.9).
		const row = POSTURES.find((candidate) => candidate.dependency === "seam-target");
		assert.ok(
			row !== undefined &&
				/governed/i.test(row.failureShape) &&
				/(descendant|inside|within|under)/i.test(row.failureShape),
			`seam-target failure shape: ${JSON.stringify(row?.failureShape)}`,
		);
	});
});

describe("state-root creation is explicit and excluded at creation (§4.7, AC7)", () => {
	let fixture: Fixture;
	let repo: GitRepo;
	/** `<repo>/.ghjig/state` inside the DISPOSABLE fixture repository. */
	let stateRoot: string;

	before(() => {
		fixture = buildFixture({ script: [], gitRepo: {} });
		const built = fixture.gitRepo;
		assert.ok(built !== undefined, "fixture was built without a git repository");
		repo = built;
		stateRoot = join(repo.root, ".ghjig", "state");
	});
	after(() => removeFixture(fixture));

	it("creates the state root", async () => {
		await ensureStateRoot(stateRoot);
		assert.equal(statSync(stateRoot).isDirectory(), true);
	});

	it("creates it with a restrictive mode", async () => {
		// Under a zeroed umask, so the arm reads the mode the runtime asks for
		// rather than the one the host's umask leaves behind (§3.12).
		const savedUmask = process.umask(0o000);
		const fresh = join(repo.root, ".ghjig", "mode-probe");
		try {
			await ensureStateRoot(fresh);
			assert.equal((statSync(fresh).mode & 0o777).toString(8), "700");
		} finally {
			process.umask(savedUmask);
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("excludes what it created from version control at creation, not by convention (§4.7)", async () => {
		// The fixture repository carries no ignore rule of its own, so the only
		// thing that can keep this state out of a commit is an exclusion the
		// creating act itself wrote. Measured as the effect — a repository that
		// still reports nothing to commit — rather than as a file name, so the
		// mechanism stays the implementation's choice.
		await ensureStateRoot(stateRoot);
		assert.equal(repo.git(["status", "--porcelain"]), "");
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
		const root = disposableTree("ghjig-install-");
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

	it("still accepts a .pi/ ancestor above the install root (upper bound unmoved)", () => {
		const root = disposableTree("ghjig-install-");
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
		const root = disposableTree("ghjig-install-");
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

describe("locate: no path component can be misread (§4.7, AC9)", () => {
	it("reads descendancy component-wise, not by prefix", () => {
		// The layout: the module is installed at `<root>/pkg/..foo/x/y`, so the
		// install root is `<root>/pkg` and the `.pi/` at `<root>/pkg/..foo` sits
		// strictly BELOW it — a genuine descendant whose first path component
		// merely begins with two dots. A prefix-shaped test reads that component
		// as an upward step, decides "not a descendant", and adopts a directory
		// inside the install tree as the repository root. The legitimate `.pi/`
		// ancestor at `<root>` is what discovery owes instead (§4.7).
		const root = disposableTree("ghjig-dotdot-");
		try {
			mkdirSync(join(root, ".pi"));
			const installDir = join(root, "pkg", "..foo", "x", "y");
			mkdirSync(installDir, { recursive: true });
			mkdirSync(join(root, "pkg", "..foo", ".pi"));
			const moduleFile = join(installDir, "locate.ts");
			writeFileSync(moduleFile, "// stand-in for the installed module\n");
			const { value, warnings } = captureWarnings(() => locateRepoRootFrom(moduleFile));
			assert.equal(
				value,
				root,
				`a directory named "..foo" below the install root was read as an ancestor; warnings: ${JSON.stringify(warnings)}`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves its own argument: a relative one still yields an absolute root", () => {
		// The module's contract is that it never consults the process working
		// directory. An entry point that hands a relative argument straight to
		// `resolve`/`dirname` inherits the cwd instead — and returns a relative
		// answer, which is the observable trace of that inheritance.
		const tree = disposableTree("ghjig-relative-arg-");
		const originalCwd = process.cwd();
		try {
			mkdirSync(join(tree, "pkg", ".pi", "extensions", "ghjig"), { recursive: true });
			writeFileSync(join(tree, "pkg", ".pi", "extensions", "ghjig", "locate.ts"), "// stand-in\n");
			process.chdir(tree);
			const { value } = captureWarnings(() =>
				locateRepoRootFrom(join("pkg", ".pi", "extensions", "ghjig", "locate.ts")),
			);
			assert.ok(isAbsolute(value), `expected an absolute repository root, got ${JSON.stringify(value)}`);
		} finally {
			process.chdir(originalCwd);
			rmSync(tree, { recursive: true, force: true });
		}
	});

	it("answers a relative argument identically from two different working directories", () => {
		// The two working directories sit at different depths, so a function
		// that resolves the argument against the cwd sees a different tree —
		// and a different structural root — each time. A function that resolves
		// its own argument sees neither tree, so both calls answer identically.
		const outer = disposableTree("ghjig-cwd-independence-");
		const inner = join(outer, "nested");
		const originalCwd = process.cwd();
		const answerFrom = (cwd: string): string => {
			process.chdir(cwd);
			return captureWarnings(() => locateRepoRootFrom(join("probe", "locate.ts"))).value;
		};
		try {
			mkdirSync(inner, { recursive: true });
			assert.equal(answerFrom(outer), answerFrom(inner));
		} finally {
			process.chdir(originalCwd);
			rmSync(outer, { recursive: true, force: true });
		}
	});

	it("returns rather than throws when the working directory is gone (§3.9)", () => {
		// Absence-shaped, never a permission bit: the working directory the
		// process sits in is removed, so anything that reaches for it fails.
		// Discovery must still return, because `repo-root-discovery` is declared
		// fail-OPEN and a throw here aborts extension load — which the substrate
		// turns into a non-zero exit, the fail-closed outcome the row denies.
		const doomed = disposableTree("ghjig-gone-cwd-");
		const originalCwd = process.cwd();
		try {
			process.chdir(doomed);
			rmSync(doomed, { recursive: true, force: true });
			assert.doesNotThrow(() =>
				captureWarnings(() => locateRepoRootFrom(join("probe", "locate.ts"))),
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(doomed, { recursive: true, force: true });
		}
	});

	it("returns rather than throws for every hostile file shape at the marker (§3.9)", () => {
		// One arm, four shapes, all file-TYPE- or absence-shaped: a `.pi` that
		// is a regular file, one that is a dangling link, one that is a link
		// loop, and an install path whose parent is not a directory at all.
		const root = disposableTree("ghjig-hostile-shapes-");
		try {
			const shapes: string[] = [];
			const plain = join(root, "plain-file", ".pi", "extensions", "ghjig");
			mkdirSync(join(root, "plain-file"), { recursive: true });
			writeFileSync(join(root, "plain-file", ".pi"), "not a directory\n");
			shapes.push(join(plain, "locate.ts"));

			const dangling = join(root, "dangling");
			mkdirSync(dangling, { recursive: true });
			symlinkSync(join(root, "no-such-target"), join(dangling, ".pi"));
			shapes.push(join(dangling, "a", "b", "c", "locate.ts"));

			const loop = join(root, "loop");
			mkdirSync(loop, { recursive: true });
			symlinkSync(join(loop, "second"), join(loop, ".pi"));
			symlinkSync(join(loop, ".pi"), join(loop, "second"));
			shapes.push(join(loop, "a", "b", "c", "locate.ts"));

			const notADirectory = join(root, "a-regular-file");
			writeFileSync(notADirectory, "the install path's own parent\n");
			shapes.push(join(notADirectory, "locate.ts"));

			for (const moduleFile of shapes) {
				assert.doesNotThrow(
					() => captureWarnings(() => locateRepoRootFrom(moduleFile)),
					`discovery threw for ${moduleFile}`,
				);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("descendancy is one predicate with one home (§3.11, §4.6, AC7/AC9)", () => {
	/**
	 * The walk that finds the repository root and the seam exclusion that
	 * refuses a target inside it ask the SAME question — is this path below
	 * that one — so they are call sites of one rule, not two implementations
	 * (§3.11 predicate ownership). Exporting it is what makes that checkable,
	 * and what lets the collision case below be measured at all: the arms are
	 * pure path reasoning, so no directory beside the governed repository has
	 * to exist for the suite to pin them.
	 *
	 * What a suite cannot observe from here is that the exclusion actually
	 * calls this predicate rather than re-deriving the question with a string
	 * prefix. The behavioural seam arms pin the two ends (a target inside the
	 * tree refuses, one outside is admitted); this block pins the rule they
	 * must be built on.
	 */
	const BASE = join(tmpdir(), "ghjig-descendancy");
	const ANCESTOR = join(BASE, "repo");

	async function isStrictDescendant(candidate: string, ancestor: string): Promise<boolean> {
		const module = (await import("../.pi/extensions/ghjig/locate.ts")) as unknown as {
			isStrictDescendant(candidate: string, ancestor: string): boolean;
		};
		return module.isStrictDescendant(candidate, ancestor);
	}

	it("reads a component beginning with two dots as the descendant it is", async () => {
		assert.equal(await isStrictDescendant(join(ANCESTOR, "..foo"), ANCESTOR), true);
	});

	it("does not read a sibling that merely shares the prefix as a descendant", async () => {
		// The false-BLOCK direction of the same defect: `<repo>-something` is a
		// different tree that a string-prefix test swallows whole, which would
		// refuse a legitimate CI layout for sitting next to the repository.
		assert.equal(await isStrictDescendant(`${ANCESTOR}-sibling`, ANCESTOR), false);
	});

	it("does not read the ancestor as a strict descendant of itself", async () => {
		// Strictness matters at the exclusion: the governed root itself is
		// refused by naming it, not by being below itself.
		assert.equal(await isStrictDescendant(ANCESTOR, ANCESTOR), false);
	});
});

describe("fail-posture inventory (§3.9, AC6)", () => {
	/**
	 * Every key the runtime consults. Enumerated here rather than derived from
	 * the table itself, because a table checked against itself declares
	 * nothing: a dependency this Execution adds without a row has to fail the
	 * suite (§6.1 — an inventory is machine-checked against the real tree, or
	 * it rots). The call-site scan below is the other half of that check, and
	 * catches a dependency a later change adds without touching this list.
	 *
	 * The rows are keyed on FAILURE SHAPES, not on components (§3.9), which is
	 * why the gate's measurement chain contributes several rows rather than
	 * one per module: resolving where the repository's refs live, deciding
	 * what a ref IS, finding which branch is the default one, reading the
	 * command, and determining what a bare push would land on are five
	 * different ways to fail, with five different things left unmeasured. A
	 * single "ref-resolution" row would declare one posture for all of them
	 * and hide which measurement was actually lost.
	 */
	const CONSULTED_DEPENDENCIES = [
		"audit-append",
		"command-parse",
		"default-branch-source",
		"gate-scope",
		"git-commondir",
		"push-target-resolution",
		"ref-identity",
		"repo-root-discovery",
		"seam-target",
	] as const;

	/**
	 * Present-but-cannot-measure: asked to vouch for something it did not
	 * measure, so it refuses (§3.9).
	 */
	const CLOSED_DEPENDENCIES = [
		"command-parse",
		"default-branch-source",
		"git-commondir",
		"push-target-resolution",
		"ref-identity",
		"seam-target",
	] as const;

	/**
	 * Fail-open, for two different reasons that this suite keeps apart:
	 * `repo-root-discovery` and `audit-append` degrade — a check that would
	 * otherwise have run did not run, which is what §3.9's "not enforced"
	 * obligation is about — while `gate-scope` is not degraded at all. Being
	 * outside the governed root is by-design inertness: a guardrail, not a
	 * sandbox (§4.6), and where nothing was examined, nothing is recorded
	 * (§3.8).
	 */
	const OPEN_DEPENDENCIES = ["audit-append", "gate-scope", "repo-root-discovery"] as const;
	const DISARMED_WHEN_OPEN = ["audit-append", "repo-root-discovery"] as const;

	/** Every `.ts` file of the shipped runtime tree — the real tree, not a list. */
	function runtimeSources(): string[] {
		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts")) {
					found.push(full);
				}
			}
		};
		walk(join(REPO_ROOT, ".pi", "extensions"));
		return found;
	}

	/** Keys the runtime asks the inventory about, read off its own call sites. */
	function consultedKeysInTree(): string[] {
		const keys = new Set<string>();
		for (const file of runtimeSources()) {
			for (const match of readFileSync(file, "utf8").matchAll(/\bposture\(\s*"([^"]+)"/g)) {
				keys.add(match[1]);
			}
		}
		return [...keys].sort();
	}

	it("declares one row per dependency the runtime consults", () => {
		assert.deepEqual(POSTURES.map((row) => row.dependency).sort(), [...CONSULTED_DEPENDENCIES]);
	});

	it("is consulted through the accessor at least somewhere in the runtime tree", () => {
		// Without this, the call-site check below passes on an empty scan —
		// an inventory nothing reads is not an inventory (§6.1).
		assert.notEqual(consultedKeysInTree().length, 0);
	});

	it("resolves every key its own call sites name", () => {
		const declared = new Set(POSTURES.map((row) => row.dependency));
		assert.deepEqual(
			consultedKeysInTree().filter((key) => !declared.has(key)),
			[],
			"a dependency the runtime consults has no row in the inventory",
		);
	});

	it("loads without evaluating anything that can fail", async () => {
		// The timing half of the arm below: the module has to reach a loaded
		// state at all. A throw during evaluation aborts extension load, which
		// the substrate reports as a non-zero exit — the fail-CLOSED outcome
		// the `repo-root-discovery: open` row denies.
		await assert.doesNotReject(() => import("../.pi/extensions/ghjig/postures.ts"));
	});

	it("refuses an unknown key at the call, after that load has already happened", async () => {
		// Reached only through a module that has already evaluated, so the
		// refusal this pins is a call-time one by construction. The refusal has
		// to NAME the key it refused, which is also what separates a real
		// refusal from the accidental throw of calling something that is not
		// there (§3.9 — a failure names its offending source).
		const { posture } = await postureModule();
		assert.throws(() => posture("no-such-dependency"), /no-such-dependency/);
	});

	it("fails closed on every dependency that can be present but unmeasurable (§3.9)", async () => {
		// The keying rule: absent means never installed and fails open; present
		// but cannot measure is being asked to vouch for what it did not
		// measure, and refuses. Every measurement the gate stands on is of the
		// second kind.
		const { posture } = await postureModule();
		assert.deepEqual(
			CLOSED_DEPENDENCIES.map((key) => posture(key).posture),
			CLOSED_DEPENDENCIES.map(() => "closed"),
		);
	});

	it("fails open only where nothing was installed or nothing is governed (§3.9, §4.6)", async () => {
		// The other side of the same rule, so the direction map is pinned in
		// both directions rather than only where it blocks.
		const { posture } = await postureModule();
		assert.deepEqual(
			OPEN_DEPENDENCIES.map((key) => posture(key).posture),
			OPEN_DEPENDENCIES.map(() => "open"),
		);
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

	it("states the degradation signal of every row whose open posture disarms a check", async () => {
		const { posture } = await postureModule();
		for (const key of DISARMED_WHEN_OPEN) {
			const signal = posture(key).degradationSignal;
			assert.ok(
				typeof signal === "string" && signal.trim() !== "",
				`fail-open row ${key} declares no degradation signal`,
			);
		}
	});

	it("says NOT ENFORCED plainly in each of those signals (§3.9)", async () => {
		// These two open postures are disarmed checks: something that would
		// otherwise have run did not run. A reader must never mistake one for a
		// passing one, and inferring it from the consequence is exactly what
		// §3.9 forbids.
		const { posture } = await postureModule();
		for (const key of DISARMED_WHEN_OPEN) {
			assert.match(posture(key).degradationSignal ?? "", /not enforced/i, `fail-open row ${key}`);
		}
	});

	it("declares NO degradation signal on gate-scope — inertness is not a disarmed check (§4.6)", async () => {
		// Outside the governed root there is no check to disarm: enforcement is
		// transparently inert by design, a guardrail rather than a sandbox. A
		// required signal here would manufacture a "not enforced" line for
		// every unrelated directory on the host and contradict the rule that
		// where nothing was examined, nothing is recorded (§3.8).
		const { posture } = await postureModule();
		assert.equal(posture("gate-scope").degradationSignal, undefined);
	});

	it("and records nothing at all when it is inert (§3.8, §4.6)", async () => {
		// The row's claim, measured: a directory that is no repository at all
		// is outside every governed root by construction, and the gate leaves
		// it exactly as it found it — no sink, no record, no line.
		const { applyGate } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as {
			applyGate(input: { cwd: string; command: string; stateRoot: string }): unknown;
		};
		const ungoverned = disposableTree("ghjig-ungoverned-");
		try {
			applyGate({
				cwd: ungoverned,
				command: 'git commit --allow-empty -m "docs: a change outside every governed root"',
				stateRoot: ungoverned,
			});
			assert.deepEqual(listTreeEntries(ungoverned), []);
		} finally {
			rmSync(ungoverned, { recursive: true, force: true });
		}
	});

	it("says it at the surface too: the repo-root degradation warns NOT ENFORCED (§3.9)", () => {
		// The declared signal and the emitted one are the same claim; a row that
		// says it and a warning that does not leaves the operator with the
		// consequence and no name for it.
		const root = disposableTree("ghjig-install-");
		try {
			const deep = join(root, "x", "nested", "a", "b");
			mkdirSync(deep, { recursive: true });
			const moduleFile = join(deep, "locate.ts");
			writeFileSync(moduleFile, "// stand-in for the installed module\n");
			const { warnings } = captureWarnings(() => locateRepoRootFrom(moduleFile));
			assert.match(warnings.join("\n"), /not enforced/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("unmodelled-bypass residuals are not a second posture table (§3.11, AC6)", () => {
	it("enumerates at least one residual — an empty enumeration declares nothing", async () => {
		assert.notEqual((await residuals()).length, 0);
	});

	it("names the vector of every residual", async () => {
		for (const entry of await residuals()) {
			assert.ok(typeof entry.vector === "string" && entry.vector.trim() !== "", JSON.stringify(entry));
		}
	});

	it("says why every residual is deliberately not modelled", async () => {
		for (const entry of await residuals()) {
			assert.ok(typeof entry.reason === "string" && entry.reason.trim() !== "", JSON.stringify(entry));
		}
	});

	it("says where each residual's coverage is homed instead", async () => {
		// A declared deferral names the surface that does cover it; without
		// that, a residual reads as an oversight rather than as a decision.
		for (const entry of await residuals()) {
			assert.ok(typeof entry.homedAt === "string" && entry.homedAt.trim() !== "", JSON.stringify(entry));
		}
	});

	it("keeps its keys disjoint from the posture inventory's", async () => {
		// Two tables, two questions. A key in both is a dependency being
		// declared twice — the second posture table §3.11's predicate-ownership
		// rule forbids.
		const declared = new Set(POSTURES.map((row) => row.dependency));
		assert.deepEqual(
			(await residuals()).map((entry) => entry.vector).filter((vector) => declared.has(vector)),
			[],
		);
	});

	it("carries no posture and no fail direction on any entry", async () => {
		for (const entry of await residuals()) {
			const shape = { keys: Object.keys(entry), values: Object.values(entry) };
			assert.ok(
				!shape.keys.some((key) => /posture|fail/i.test(key)) &&
					!shape.values.some((value) => value === "open" || value === "closed"),
				`a residual entry carries a fail posture: ${JSON.stringify(entry)}`,
			);
		}
	});
});
