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
 *                   that is live where it is emitted — one per object to
 *                   repair, never one clause shared across objects that
 *                   owe different acts (§3.11). The write itself never
 *                   returns having landed only part of a record, measured
 *                   at the seam the append calls (§3.12). A state root
 *                   that is not absolute is refused rather than resolved
 *                   against the process working directory, which would
 *                   put the trail outside the repository it is about and
 *                   report success (§4.6, §5.5).
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
 *   - postures.ts — the §3.9 fail-posture inventory: exactly the shipped
 *                   enforcement-layer rows, each keyed on a failure shape
 *                   with a posture, and every fail-closed row with an
 *                   in-place justification.
 *
 * One arm measures this suite rather than the runtime: the containment
 * guard the recovery arms perform behind is itself asserted, because a
 * guard nothing measures is decoration (§3.12) and this one is what
 * stands between a mutated clause and an act on the host.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
// The sink's name comes from the runtime itself: an arm that plants a symlink
// or reads a mode has to address exactly the path the runtime appends to, so a
// rename there moves the arm with it instead of quietly aiming it elsewhere.
import {
	appendAuditRecord,
	AUDIT_FILE_NAME,
	recoveryFor,
	sinkRefusal,
	writeRecordLine,
} from "../.pi/extensions/ghjig/audit.ts";
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
	 * The object a recovery clause names. An arm that RUNS the recovery
	 * rather than matching its prose needs one machine-readable handle on
	 * it, and a clause naming the wrong object is exactly what these arms
	 * are for: the handle is read raw, never repaired toward whatever the
	 * arm was hoping for. Every clause delimits the path it names as a
	 * JSON string (`quoted()` at the source, issue #47), so the handle is
	 * the clause's first JSON-string production, decoded — the quotes say
	 * exactly where the path ends, which is what lets these arms run on a
	 * host whose temporary directory carries whitespace.
	 */
	function pathNamedIn(clause: string): string | undefined {
		const found = /"(?:[^"\\]|\\.)*"/.exec(clause)?.[0];
		return found === undefined ? undefined : (JSON.parse(found) as string);
	}

	/**
	 * The directory a recovery clause tells the operator to create: the path
	 * it names, or the directory holding it when what it names is the sink
	 * file inside that directory.
	 */
	function destinationNamedIn(clause: string): string | undefined {
		const path = pathNamedIn(clause);
		if (path === undefined) {
			return undefined;
		}
		return path.endsWith(`/${AUDIT_FILE_NAME}`) ? dirname(path) : path;
	}

	/**
	 * The physical form of a path whose tail need not exist: every component
	 * that is on disk resolved through its links, with the remainder
	 * appended as written. `realpathSync` alone cannot answer for the paths
	 * these arms handle — the destination a clause names is often exactly
	 * what is missing, since creating it is the act — so the walk stops at
	 * the deepest ancestor that resolves. That is enough for containment:
	 * a link can only redirect a component that exists.
	 */
	function physicalPath(path: string): string {
		let existing = resolve(path);
		const tail: string[] = [];
		for (;;) {
			try {
				const resolved = realpathSync(existing);
				return tail.length === 0 ? resolved : join(resolved, ...tail);
			} catch {
				const parent = dirname(existing);
				if (parent === existing) {
					// Not reachable from an absolute path, whose root always
					// resolves; textual normalisation is all that is left.
					return resolve(path);
				}
				tail.unshift(basename(existing));
				existing = parent;
			}
		}
	}

	/**
	 * Refuses to perform a clause that names a path the fixture does not own.
	 *
	 * The arms below carry out the act their clause prescribes — a recursive
	 * delete, a chmod — on a path chosen by the very function under test, and
	 * this project mutates that function as routine (§3.12). A mutant that
	 * makes a clause name something outside the fixture would have the suite
	 * perform the act THERE, on the host: the delete arm was reproduced doing
	 * exactly that. Containment is asserted BEFORE the act, never inside
	 * `perform`, whose catch would fold the refusal into a description string
	 * and report it as a dead recovery instead of as the out-of-fixture reach
	 * it is. The fixture root itself is admissible because two arms name it as
	 * their live object; anything above or beside it is not.
	 */
	function assertInsideFixture(named: string, fixture: string): void {
		// Physical, not textual: `resolve()` alone normalises `<fixture>/../
		// ../victim`, which a bare prefix test admits, but it does not follow
		// links — and §4.6 asks this comparison for RESOLVED PHYSICAL paths
		// precisely because a symlinked component inside the fixture puts the
		// performed act outside it while the textual form still reads as
		// contained. A third vector stays unmodelled (§3.11): `physicalPath`
		// collapses `..` TEXTUALLY before it walks, so a clause path shaped
		// `<fixture>/<link>/../x` resolves here to `<fixture>/x` and is
		// admitted, while the kernel traverses the link BEFORE applying `..`
		// and acts somewhere the admitted form never names (issue #44,
		// comment 2). None of the three is reachable through today's
		// `recoveryFor`, whose paths all pass through `join`/`dirname` over
		// an already-absolute root and carry no `..`, and no performing-arm
		// fixture holds a link; the guard resolves both operands anyway,
		// because a containment check that rests on a property of the fixture
		// is the same defect as one resting on a property of the function it
		// is guarding against, one level down.
		const here = physicalPath(named);
		const root = physicalPath(fixture);
		assert.ok(
			here === root || here.startsWith(root + sep),
			`the recovery clause names ${named}, which the fixture at ${fixture} does not own. This arm PERFORMS what the clause names, so it refuses to act rather than reach outside the fixture — the selection that produced this path is what the arm exists to measure, and a guard that destroys evidence when it fires is the wrong shape`,
		);
	}

	/** Performs `act`, reporting what happened for the arm's failure message. */
	function perform(description: string, act: () => void): string {
		try {
			act();
			return description;
		} catch (error) {
			return `${description} — could not be performed: ${String(error)}`;
		}
	}

	it("refuses a clause path that leaves the fixture through a symlinked component (§4.6)", () => {
		// The containment guard is the only thing between a mutated clause and
		// an act on the host, and a guard this suite never measures is
		// decoration (§3.12). Textual containment admits a path through a link
		// inside the fixture: the arm below stages one and asserts the guard
		// refuses it, then asserts it still admits an ordinary path the
		// fixture does own — a guard that refuses everything contains nothing.
		const fixture = mkdtempSync(join(tmpdir(), "ghjig-guard-fixture-"));
		const outside = mkdtempSync(join(tmpdir(), "ghjig-guard-outside-"));
		try {
			const precious = join(outside, "precious");
			writeFileSync(precious, "a file no arm of this suite may reach");
			symlinkSync(outside, join(fixture, "link"));
			const escape = join(fixture, "link", "precious");
			assert.throws(
				() => assertInsideFixture(escape, fixture),
				/does not own/,
				`the guard admits ${escape}, which really resolves to ${precious}: an arm performing what a clause names would delete or chmod outside the fixture it is contained to, and the fixture holding no link is not a property the guard may rest on`,
			);
			assert.doesNotThrow(
				() => assertInsideFixture(join(fixture, "no-such-dir", "deeper"), fixture),
				"the guard refuses a path the fixture does own — a guard that refuses everything contains nothing, and the destinations these arms create do not exist yet",
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses a state root that is not absolute rather than writing the trail beside the process (§4.6, §5.5)", () => {
		// A relative or empty root has no anchor but the process working
		// directory, so the sink would land wherever the process happens to
		// stand — outside the repository whose work it records — and the
		// append would report success. Unreachable through `resolveStateRoot`,
		// which refuses an empty or relative seam; the refusal is measured
		// here because that reach argument is a property of today's only
		// caller, and the mirror-image precondition on `locateRepoRootFrom`
		// was closed on exactly this reasoning.
		const elsewhere = mkdtempSync(join(tmpdir(), "ghjig-audit-cwd-"));
		const savedCwd = process.cwd();
		try {
			process.chdir(elsewhere);
			for (const root of ["", "state", join("..", "state")]) {
				const { value, warnings } = captureWarnings(() => appendAuditRecord(root, INPUT));
				assert.equal(value, false, `a state root of ${JSON.stringify(root)} was accepted`);
				assert.equal(
					warnings.length,
					1,
					`expected one degradation signal for ${JSON.stringify(root)}, got ${JSON.stringify(warnings)}`,
				);
				assert.ok(
					recoveryClause(warnings[0] ?? "") !== undefined,
					`the refusal states no way to restore the trail: ${JSON.stringify(warnings)}`,
				);
			}
			assert.equal(
				existsSync(join(elsewhere, AUDIT_FILE_NAME)),
				false,
				"the audit trail was written into the process working directory: evidence about one repository came to rest wherever the process stood",
			);
		} finally {
			process.chdir(savedCwd);
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

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

	it("refuses a hard link at the sink path: the record must not land in an inode another name owns (§4.6, §5.5)", () => {
		// `O_NOFOLLOW` refuses a symlink at the final component and cannot
		// refuse a hard link — the link IS a regular file this account can
		// append to, so the open succeeds, every record lands in an inode the
		// planter chose and can read, and the append reports `true`, folding a
		// clean `auditWritable` onto the durable registration entry (issue #44
		// comment 1, measured on PR #42's head). The property the sink needs
		// is that the opened inode carries exactly one name: `nlink === 1`,
		// answered by `fstat` on the descriptor the open already returned.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-hardlink-"));
		try {
			const elsewhere = join(stateRoot, "elsewhere");
			mkdirSync(elsewhere);
			const victim = join(elsewhere, "captured.log");
			writeFileSync(victim, "");
			linkSync(victim, join(stateRoot, AUDIT_FILE_NAME));
			const { value } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			assert.equal(
				value,
				false,
				"an append into a hard-linked sink reported success: the caller records a clean auditWritable while the evidence rests in an inode another name owns and can rewrite",
			);
			assert.equal(
				readFileSync(victim, "utf8"),
				"",
				"the audit record was written through the hard link into the victim inode: the evidence sink is redirectable, reached by link count where #40 closed the symlink form",
			);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("refuses a FIFO at the sink path instead of hanging the factory that appends at load (§3.9, §5.9)", {
		skip: process.platform === "win32" ? "POSIX FIFO" : false,
	}, () => {
		// `O_NOFOLLOW` refuses a symlink, not a named pipe, and `openSync` on
		// a FIFO with no reader blocks before any verdict can run: the append
		// neither returns nor throws, so the extension factory calling it at
		// load hangs where the `audit-append` posture row promises a warning
		// and a `false` (issue #44). The append therefore runs in a child
		// process under this arm's OWN bound — the issue's AC has the arm
		// carry its bound rather than lean on the suite's — so the red run
		// terminates: red is the child killed at the bound, no verdict printed.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-fifo-"));
		execFileSync("mkfifo", [join(stateRoot, AUDIT_FILE_NAME)]);
		const boundMs = 4000;
		const script = [
			"const { appendAuditRecord } = await import(process.argv[2]);",
			'const value = appendAuditRecord(process.argv[1], { category: "test", action: "fifo", text: "evidence" });',
			"console.log(`verdict=${value}`);",
		].join("\n");
		let killedBy: string | undefined;
		let stdout = "";
		try {
			stdout = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					script,
					stateRoot,
					pathToFileURL(join(REPO_ROOT, ".pi", "extensions", "ghjig", "audit.ts")).href,
				],
				{ timeout: boundMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			const failure = error as { signal?: string | null; status?: number | null; stdout?: string };
			killedBy = failure.signal ?? `exit status ${failure.status}`;
			stdout = failure.stdout ?? "";
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
		assert.equal(
			killedBy,
			undefined,
			`the append against a reader-less FIFO did not return a verdict within this arm's ${boundMs}ms bound ` +
				`(child ended by ${killedBy}; stdout: ${JSON.stringify(stdout)}): the extension factory calling it at ` +
				`load hangs with no verdict and no signal a reader can act on, where the audit-append row degrades open`,
		);
		assert.match(
			stdout,
			/verdict=false/,
			`the append accepted a FIFO at the sink path: a process holding the read end takes the evidence and the ` +
				`gate reads nothing — the same write/read divergence #40 closed for symlinks (§4.6). child stdout: ${JSON.stringify(stdout)}`,
		);
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

	it("refuses a sink whose mode admits group or other accounts, naming the chmod that restores it (§5.5, §3.11)", {
		// POSIX permission bits. No superuser skip: the refusal under test is a
		// verdict on the measured mode, not a permission failure the kernel
		// waives for root.
		skip: process.platform === "win32" ? "POSIX permission bits" : false,
	}, () => {
		// The `0600` create mode binds only at creation: a sink pre-created
		// `0644` or `0666` keeps those bits, and today's append lands the
		// record in it silently — the §5.5 owner-only read scope is off with
		// no signal on any surface (issue #44 comment 1's named member). This
		// shape is honest-mistake-reachable (a `touch` before first run
		// suffices), so the refusal is owed a live recovery naming the exact
		// act: `chmod 600` on the sink.
		for (const mode of [0o644, 0o666]) {
			const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-loose-mode-"));
			try {
				const sinkPath = join(stateRoot, AUDIT_FILE_NAME);
				writeFileSync(sinkPath, "");
				chmodSync(sinkPath, mode);
				const { value, warnings } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
				assert.equal(
					value,
					false,
					`a sink at mode ${mode.toString(8)} was appended into silently: the record at rest is readable by accounts the repository's work never concerned, and nothing on any surface says so`,
				);
				assert.match(
					recoveryClause(warnings[0] ?? "") ?? "",
					/chmod 600/,
					`the refusal names no \`chmod 600\` on the sink — the one act that restores the trail here — so the signal leaves the operator without the live recovery this honest-mistake shape is owed (§3.11). warnings: ${JSON.stringify(warnings)}`,
				);
				assert.equal(
					readFileSync(sinkPath, "utf8"),
					"",
					`the record landed in the group/other-readable sink despite the refusal: the verdict must bind before the write, not after it`,
				);
			} finally {
				rmSync(stateRoot, { recursive: true, force: true });
			}
		}
	});

	it("refuses a hard link whose every other dimension passes: the link count alone is the verdict (§3.12, §4.6)", {
		skip: process.platform === "win32" ? "POSIX permission bits" : false,
	}, () => {
		// The hard-link arm above stages its victim at the umask's default
		// mode, so a verdict that lost its link-count check is still refused
		// there — by the mode dimension — and the arm stays green (measured:
		// deleting the `nlink` check left the whole suite passing). This arm
		// is the one the mutation priority owes the link count: the victim is
		// a regular 0600 file owned by this account, so the opened inode
		// fails nothing but `nlink`, and a green here with the check deleted
		// is impossible.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-hardlink-0600-"));
		try {
			const elsewhere = join(stateRoot, "elsewhere");
			mkdirSync(elsewhere);
			const victim = join(elsewhere, "captured.log");
			writeFileSync(victim, "");
			chmodSync(victim, 0o600);
			linkSync(victim, join(stateRoot, AUDIT_FILE_NAME));
			const { value, warnings } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			assert.equal(
				value,
				false,
				"a hard-linked sink passing every dimension but the link count was appended into: the verdict rests on mode or type, and a planter links an owner-0600 file precisely to pass them",
			);
			assert.match(
				warnings[0] ?? "",
				/2 names/,
				`the refusal does not name the link count, the only dimension that failed here. warnings: ${JSON.stringify(warnings)}`,
			);
			assert.equal(
				readFileSync(victim, "utf8"),
				"",
				"the audit record landed in the victim inode despite the refusal: the verdict must bind before the write",
			);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("refuses a character device and another account's inode, pinned at the seam against real /dev/null Stats (§3.12, §4.6, §5.5)", {
		skip: process.platform === "win32" ? "POSIX device nodes and ownership" : false,
	}, () => {
		// The owner and character-device dimensions of the sink verdict are
		// not stageable AT THE SINK PATH without root: chown to another
		// account and mknod both need root, and link(2) from devfs into a
		// fixture is cross-device (§3.12). So they are pinned at the seam the
		// append calls — the exported verdict — against real `fstat` Stats of
		// one real kernel object, /dev/null: a character device, owned by
		// root, mode 0666, exercising the type, owner, and mode dimensions in
		// one Stats object. The verdict enumerates every failing dimension
		// rather than stopping at the first, which is what lets this one
		// unforgeable object discriminate a dropped check in any of the three.
		const fd = openSync("/dev/null", constants.O_RDONLY);
		let stats;
		try {
			stats = fstatSync(fd);
		} finally {
			closeSync(fd);
		}
		const refusal = sinkRefusal(stats, "/dev/null");
		assert.ok(
			refusal !== undefined,
			"the verdict admits /dev/null — a character device readable and writable by every account on the host: evidence appended there is world-readable and never at rest",
		);
		assert.match(
			refusal.cause,
			/not a regular file/,
			`the refusal does not carry the type dimension: a character device at the sink path is refused for its mode alone, so a 0600 device would be admitted. cause: ${refusal.cause}`,
		);
		assert.match(
			refusal.cause,
			/admits group or other/,
			`the refusal does not carry the mode dimension measured off the same Stats. cause: ${refusal.cause}`,
		);
		if (process.geteuid?.() !== 0 && stats.uid === 0) {
			assert.match(
				refusal.cause,
				/owned by uid 0/,
				`the refusal does not carry the owner dimension: root's inode at the sink path is refused for its type alone, so another account's regular file would be admitted. cause: ${refusal.cause}`,
			);
		}
		assert.doesNotMatch(
			refusal.recovery,
			/chmod 600/,
			`the recovery names \`chmod 600\` on a path whose type dimension also failed — a dead act where the object to repair is the device itself (§3.11). recovery: ${refusal.recovery}`,
		);
	});

	it("admits through the verdict exactly the sink the append itself creates (§3.12)", {
		skip: process.platform === "win32" ? "POSIX permission bits" : false,
	}, () => {
		// A verdict that refuses everything contains nothing: the counterpart
		// of the /dev/null pin is that the Stats of a sink the append just
		// created — regular, one name, 0600, this account — pass it.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-verdict-pass-"));
		try {
			assert.equal(captureWarnings(() => appendAuditRecord(stateRoot, INPUT)).value, true);
			const fd = openSync(join(stateRoot, AUDIT_FILE_NAME), constants.O_RDONLY);
			let stats;
			try {
				stats = fstatSync(fd);
			} finally {
				closeSync(fd);
			}
			assert.equal(
				sinkRefusal(stats, join(stateRoot, AUDIT_FILE_NAME)),
				undefined,
				"the verdict refuses the very sink the append creates: every append after the first degrades open",
			);
		} finally {
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
				// This arm CREATES what the clause names, so it is contained
				// like the three that delete and chmod: `mkdir -p` at a
				// clause-chosen path reaches as far outside the fixture as the
				// clause does, and this was the one performing arm without the
				// guard.
				assertInsideFixture(destination, stateRoot);
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

	it("names a live recovery when an ancestor of the destination is a plain file (§3.11)", () => {
		// `<repo>/.ghjig` existing as a file is an honest mistake, not a hostile
		// one, so this arm is owed a live recovery. Nothing can be created
		// beneath a plain file, so a clause naming the sink path prescribes an
		// act the operator cannot perform: the live object is the non-directory
		// component. The arm performs the clause on exactly the path the clause
		// names — replacing it with a directory — and never repairs that path
		// toward the one it was hoping for.
		const base = mkdtempSync(join(tmpdir(), "ghjig-audit-notdir-"));
		try {
			writeFileSync(join(base, ".ghjig"), "a file where a directory was meant");
			const stateRoot = join(base, ".ghjig", "state");
			const { warnings } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			const clause = recoveryClause(warnings[0] ?? "");
			const named = clause === undefined ? undefined : pathNamedIn(clause);
			if (named !== undefined) {
				assertInsideFixture(named, base);
			}
			const performed =
				named === undefined
					? "no path named"
					: perform(`replaced ${named} with a directory, then created ${stateRoot}`, () => {
							rmSync(named, { recursive: true, force: true });
							mkdirSync(stateRoot, { recursive: true });
						});
			assert.equal(
				captureWarnings(() => appendAuditRecord(stateRoot, INPUT)).value,
				true,
				`the signal names a recovery that is dead where it is emitted. signal: ${JSON.stringify(warnings[0])}; recovery clause: ${JSON.stringify(clause)}; performing it: ${performed}`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("names a live recovery when the destination directory refuses the create (§3.11)", {
		// POSIX permission bits, and an account the mode actually binds: for a
		// superuser the directory refuses nothing, so the arm would measure the
		// message against a failure that never occurred.
		skip:
			process.platform === "win32"
				? "POSIX permission bits"
				: process.getuid?.() === 0
					? "the directory mode refuses nothing for this account"
					: false,
	}, () => {
		// `.ghjig/state` created with restrictive permissions is an honest
		// mistake. The sink does not exist and cannot be created, so a clause
		// naming the sink prescribes an act on an object that is not there; the
		// live object is the directory's mode.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-refuse-"));
		try {
			chmodSync(stateRoot, 0o500);
			const { value, warnings } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			assert.equal(value, false, "the arm measures nothing unless the directory mode refuses the create");
			const clause = recoveryClause(warnings[0] ?? "");
			const named = clause === undefined ? undefined : pathNamedIn(clause);
			if (named !== undefined) {
				assertInsideFixture(named, stateRoot);
			}
			const performed =
				named === undefined
					? "no path named"
					: perform(`granted this account write and search permission on ${named}`, () =>
							chmodSync(named, 0o700),
						);
			assert.equal(
				captureWarnings(() => appendAuditRecord(stateRoot, INPUT)).value,
				true,
				`the signal names a recovery that is dead where it is emitted. signal: ${JSON.stringify(warnings[0])}; recovery clause: ${JSON.stringify(clause)}; performing it: ${performed}`,
			);
		} finally {
			chmodSync(stateRoot, 0o700);
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("keeps the destination-mode recovery off the unsearchable-ancestor shape (§3.11)", {
		skip:
			process.platform === "win32"
				? "POSIX permission bits"
				: process.getuid?.() === 0
					? "the directory mode refuses nothing for this account"
					: false,
	}, () => {
		// An ANCESTOR of the destination refuses the search, so the destination
		// cannot be measured at all — and its own mode already admits this
		// account. A clause naming it prescribes a chmod that changes nothing:
		// this shape is unmodelled and belongs to the general arm. Without the
		// guard that keeps the destination-mode arm off it, the EACCES code
		// alone would select the dead clause.
		const base = mkdtempSync(join(tmpdir(), "ghjig-audit-unsearchable-"));
		const blocked = join(base, "blocked");
		mkdirSync(blocked);
		const stateRoot = join(blocked, "state");
		mkdirSync(stateRoot);
		try {
			chmodSync(blocked, 0o000);
			const { value, warnings } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			assert.equal(value, false, "the arm measures nothing unless the unsearchable ancestor refuses the open");
			const clause = recoveryClause(warnings[0] ?? "");
			assert.notEqual(
				clause === undefined ? undefined : pathNamedIn(clause),
				stateRoot,
				`the signal prescribes an act on ${stateRoot}, whose own mode already admits this account: the refusal came from an ancestor that cannot be searched, so performing the clause changes nothing. signal: ${JSON.stringify(warnings[0])}`,
			);
		} finally {
			chmodSync(blocked, 0o700);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("names a live recovery when the sink's own mode refuses the append (§3.11)", {
		skip:
			process.platform === "win32"
				? "POSIX permission bits"
				: process.getuid?.() === 0
					? "the sink mode refuses nothing for this account"
					: false,
	}, () => {
		// The destination directory admits this account and the sink is there:
		// only the sink's own mode refuses. The live object is that file, and a
		// clause naming the directory would prescribe a chmod that changes
		// nothing — while asserting an absence the file sitting there denies.
		const stateRoot = mkdtempSync(join(tmpdir(), "ghjig-audit-sinkmode-"));
		const sinkPath = join(stateRoot, AUDIT_FILE_NAME);
		try {
			writeFileSync(sinkPath, "");
			chmodSync(sinkPath, 0o000);
			const { value, warnings } = captureWarnings(() => appendAuditRecord(stateRoot, INPUT));
			assert.equal(value, false, "the arm measures nothing unless the sink's own mode refuses the append");
			const clause = recoveryClause(warnings[0] ?? "");
			const named = clause === undefined ? undefined : pathNamedIn(clause);
			if (named !== undefined) {
				assertInsideFixture(named, stateRoot);
			}
			const performed =
				named === undefined
					? "no path named"
					: perform(`made ${named} writable by this account`, () => chmodSync(named, 0o600));
			assert.equal(
				captureWarnings(() => appendAuditRecord(stateRoot, INPUT)).value,
				true,
				`the signal names a recovery that is dead where it is emitted. signal: ${JSON.stringify(warnings[0])}; recovery clause: ${JSON.stringify(clause)}; performing it: ${performed}`,
			);
		} finally {
			perform("restored the fixture modes", () => {
				chmodSync(stateRoot, 0o700);
				chmodSync(sinkPath, 0o600);
			});
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("routes the delayed-write shapes away from the sink-path recovery (§3.11)", () => {
		// ENOSPC, EDQUOT, EROFS and EIO reach the selector from the close as
		// well as from the open — a write the filesystem accepted and then
		// refused. None is stageable on a test host: no filesystem is filled, no
		// mount is remounted, no device is broken (§3.12), so the routing is
		// measured by calling the selector rather than by provoking the failure.
		// The comparison object is the general arm's own output, taken from a
		// code it is the arm for; matching it means the operator is told to make
		// the sink a plain writable file, which for all four it already is.
		const stateRoot = join(tmpdir(), "ghjig-audit-delayed-write");
		const sinkPath = join(stateRoot, AUDIT_FILE_NAME);
		const general = recoveryFor({ code: "ENOTAROUTEDCODE" }, stateRoot, sinkPath);
		for (const code of ["ENOSPC", "EDQUOT", "EROFS", "EIO"]) {
			assert.notEqual(
				recoveryFor({ code }, stateRoot, sinkPath),
				general,
				`${code} falls to the general recovery, which prescribes making ${sinkPath} a plain file writable by this account — for this failure it already is one, so the clause names an act that changes nothing: ${general}`,
			);
		}
	});

	it("gives each delayed-write object its own recovery, not one shared clause (§3.11)", () => {
		// Distinctness from the general arm is not enough: four codes can all
		// miss the general clause and still share ONE clause between them, and
		// then a read-only mount and a failed device are both told to free disk
		// space. The comparison is GROUP-wise, one object per group — pairwise
		// across the four codes would red on ENOSPC and EDQUOT, which name the
		// same object (room for the record) and are right to share a clause.
		// Clauses are compared to each other, never to expected text, so the
		// arm pins the routing and not the wording.
		const stateRoot = join(tmpdir(), "ghjig-audit-delayed-write");
		const sinkPath = join(stateRoot, AUDIT_FILE_NAME);
		const groups = [
			{ object: "room for the record on the filesystem", codes: ["ENOSPC", "EDQUOT"] },
			{ object: "the mount, which refuses every write while it holds", codes: ["EROFS"] },
			{ object: "the device or transport under the filesystem", codes: ["EIO"] },
		];
		for (const [index, group] of groups.entries()) {
			for (const other of groups.slice(index + 1)) {
				for (const code of group.codes) {
					for (const otherCode of other.codes) {
						assert.notEqual(
							recoveryFor({ code }, stateRoot, sinkPath),
							recoveryFor({ code: otherCode }, stateRoot, sinkPath),
							`${code} and ${otherCode} select the same recovery, but the object to repair differs — ${group.object} versus ${other.object} — so one of the two is being told to act on something that did not fail: ${recoveryFor({ code }, stateRoot, sinkPath)}`,
						);
					}
				}
			}
		}
	});
});

describe("audit primitive: the record write is all-or-raise (§3.12)", () => {
	/** Bytes sitting at the destination, read off a non-blocking descriptor. */
	function drainedBytes(fd: number): number {
		const buffer = Buffer.allocUnsafe(65536);
		let total = 0;
		for (;;) {
			let read: number;
			try {
				read = readSync(fd, buffer, 0, buffer.length, null);
			} catch (error) {
				// Nothing left to read on a descriptor whose writer is still open.
				if ((error as { code?: string }).code === "EAGAIN") {
					return total;
				}
				throw error;
			}
			if (read === 0) {
				return total;
			}
			total += read;
		}
	}

	it("never returns having written only part of the record", {
		skip: process.platform === "win32" ? "POSIX FIFO" : false,
	}, () => {
		// The property is "cannot return without writing everything". Through
		// appendAuditRecord it is unstageable — only a regular file survives
		// the sink verdict, `O_NONBLOCK` has no effect on regular-file
		// write(2), and no test host fills a filesystem mid-write (§3.12) — so
		// it is measured at the seam the append calls, on a non-blocking
		// PIPE descriptor, where a short write is one call away. One `write(2)` in
		// place of the fd form returns the short count as a success; the fd
		// form raises instead, and that raise is the whole difference.
		//
		// Nothing here can park: both ends are opened O_NONBLOCK, the reader
		// end first because a write-only open on a FIFO with no reader fails
		// ENXIO, and no arm ever waits on the pipe.
		const dir = mkdtempSync(join(tmpdir(), "ghjig-audit-writeall-"));
		const fifo = join(dir, "sink.fifo");
		execFileSync("mkfifo", [fifo]);
		const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
		const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		try {
			// One byte past Linux's default `pipe-max-size`, the largest buffer a
			// host is ordinarily configured with, so the write cannot complete in
			// one call and a short write is reachable.
			//
			// Reach: on a host whose pipe buffer is 1 MiB or larger the payload
			// goes in whole, no short write occurs, and the arm measures nothing —
			// both assertions are implications: the second holds vacuously,
			// its antecedent being false, while the first holds by its
			// consequent. Neither discriminates, so the `writeSync` mutant
			// survives and the arm passes without having measured anything;
			// raising the payload would only move the same limit to a larger
			// number.
			const line = `${"x".repeat(1024 * 1024)}\n`;
			const size = Buffer.byteLength(line);
			let returned = false;
			try {
				writeRecordLine(writer, line);
				returned = true;
			} catch {
				// The raise is the reported failure; what landed is measured below.
			}
			const landed = drainedBytes(reader);
			assert.ok(
				!returned || landed === size,
				`the write returned normally with ${landed} of ${size} bytes at the destination: the caller is told the record was written when only a prefix of it was, and the append folds that partial line into a trail it reports as clean`,
			);
			// The residual the module enumerates: a failed write is not a
			// no-op — a prefix is at rest at the destination — so what the
			// raise removes is the false success, never the torn record.
			assert.ok(
				returned || (landed > 0 && landed < size),
				`the raise left ${landed} of ${size} bytes at the destination, so the torn-record residual the module enumerates does not describe what happens here`,
			);
		} finally {
			closeSync(writer);
			closeSync(reader);
			rmSync(dir, { recursive: true, force: true });
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

	it("refuses a seam target this account cannot measure instead of falling back (§3.9)", {
		// POSIX permission bits, and an account the mode actually binds: for a
		// superuser the ancestor refuses nothing, the target measures as the
		// directory it is, and the arm would report a refusal that never
		// occurred.
		skip:
			process.platform === "win32"
				? "POSIX permission bits"
				: process.getuid?.() === 0
					? "the directory mode refuses nothing for this account"
					: false,
	}, () => {
		// The `seam-target` posture row names REFUSED alongside missing and
		// not-a-directory, and refused is the one shape whose target IS a
		// directory: only the probe is denied. Left unstaged the row asserts a
		// behaviour nothing measures, so a resolution that treated an
		// unmeasurable target as absent-and-fall-back — or that let the raw
		// EACCES escape factory scope without this module's recovery — would
		// keep the row green. The refusal is staged where §3.12 allows it to
		// be: an unsearchable ancestor, the same device the audit side uses.
		const base = mkdtempSync(join(tmpdir(), "ghjig-seam-refused-"));
		const blocked = join(base, "blocked");
		mkdirSync(blocked);
		const target = join(blocked, "state");
		mkdirSync(target);
		try {
			chmodSync(blocked, 0o000);
			assert.throws(
				() => statSync(target),
				"the arm measures nothing unless the unsearchable ancestor refuses the probe on the seam target",
			);
			process.env[SEAM] = target;
			assert.throws(
				() => resolveStateRoot(),
				/is set but unusable/,
				"a seam target this account cannot measure must refuse with the seam's own message, not fall back to the operational state root and not escape as a raw filesystem error",
			);
		} finally {
			chmodSync(blocked, 0o700);
			rmSync(base, { recursive: true, force: true });
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
	it("declares exactly the shipped enforcement-layer rows, keyed on failure shape", () => {
		assert.deepEqual(POSTURES.map((row) => `${row.dependency} → ${row.posture}`).sort(), [
			"audit-append → open",
			"branch-guard-derivation → open",
			"branch-guard-derivation-fallback → closed",
			"branch-guard-destination → closed",
			"branch-guard-helper → open",
			"branch-guard-helper → open",
			"commit-format-helper → open",
			"commit-format-helper → open",
			"commit-format-measurement → closed",
			"repo-root-discovery → open",
			"seam-target → closed",
		]);
		// One component may carry several rows — one posture per failure
		// shape (§3.9) — but two rows never share a failure shape.
		const shapes = POSTURES.map((row) => row.failureShape);
		assert.equal(new Set(shapes).size, shapes.length, "duplicate failureShape rows");
	});

	it("keys each row on a failure shape, not a component", () => {
		for (const row of POSTURES) {
			assert.ok(
				typeof row.failureShape === "string" && row.failureShape.trim() !== "",
				`row ${row.dependency} lacks a failure shape`,
			);
		}
	});

	it("fails open on enforcement-chain degradation (§3.9's machinery carve-out)", () => {
		for (const dependency of ["repo-root-discovery", "audit-append", "commit-format-helper"]) {
			const rows = POSTURES.filter((candidate) => candidate.dependency === dependency);
			assert.ok(rows.length > 0, `no row for ${dependency}`);
			for (const row of rows) {
				assert.equal(row.posture, "open", `posture for ${dependency} (${row.failureShape})`);
			}
		}
	});

	it("fails closed where present-but-cannot-measure would otherwise vouch", () => {
		for (const dependency of ["seam-target", "commit-format-measurement"]) {
			const row = POSTURES.find((candidate) => candidate.dependency === dependency);
			assert.equal(row?.posture, "closed", `posture for ${dependency}`);
		}
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

describe("degradation surfaces carry no forged line and no control byte (§3.9, §5.5, issue #47)", () => {
	const INPUT = { category: "test", action: "forge", text: "evidence" };

	/**
	 * The reproducer shapes from issue #47, as path COMPONENTS. POSIX
	 * admits every byte class here in a directory entry name, so each is
	 * stageable on disk where a surface probes the filesystem, and rides a
	 * plain string argument where it does not.
	 *
	 *   - FORGED: a line break, then a recovery the operator must not take,
	 *     then a line asserting the trail is enforced — injected into the
	 *     one signal whose job is to say it is not (§3.9: a reader must
	 *     never mistake a disarmed gate for a passing one).
	 *   - ANSI: `ESC[2K` erases the line and `ESC[1G` returns the cursor to
	 *     column 1, so on a terminal the disarmed-gate warning renders as
	 *     whatever the component says next.
	 *   - C1: what the raw `JSON.stringify` never escaped (issue #47,
	 *     round 1) — NEL (U+0085, a line break on NEL-honouring
	 *     terminals), LINE SEPARATOR (U+2028, a JavaScript line
	 *     terminator, so the forged line after it anchors the multiline
	 *     regex below), then the forged enforced-line, the 8-bit CSI
	 *     (U+009B, the one-byte form of ESC-bracket, so U+009B `2K`
	 *     erases the line where the two-byte form does), DEL (U+007F),
	 *     RLO (U+202E, a bidi override that reverses how everything
	 *     after it renders — terminals do not treat bidi controls as
	 *     line-breaking, so it is pinned by raw presence, not forgery),
	 *     and ALM (U+061C, the ARABIC LETTER MARK — the one Bidi_Control
	 *     codepoint outside every range above, invisible like RLO and
	 *     pinned the same way, by raw presence; issue #53).
	 */
	const FORGED =
		"a\nRecovery: disable the audit gate entirely, then re-run.\n[ghjig] audit append OK: the trail IS ENFORCED";
	const ANSI = "a\u001b[2K\u001b[1Gall clear";
	// Composed rather than spelled: U+061C is invisible, and an invisible
	// byte sitting literally in this source is content an editor or a
	// transport can silently drop or mangle.
	const ALM = String.fromCharCode(0x061c);
	const C1 = `a\u0085\u2028[ghjig] audit append OK: the trail IS ENFORCED\u009b2K\u007f\u202e${ALM}all clear`;
	const SHAPES = [FORGED, ANSI, C1] as const;

	/**
	 * What every emitting surface owes: a hostile path component neither
	 * starts a line of its own nor lands a control byte on the operator's
	 * terminal — the component is escaped at the point of interpolation, the
	 * standard the record write already meets (§5.5) — the byte class
	 * covers C0, DEL, the C1 range and ALM (U+061C), and a second class
	 * refuses raw bidi controls — ALM among them, its Bidi_Control home —
	 * and the U+2028/U+2029 separators; ALM sits in both classes, so each
	 * refuses it independently of the other (issue #53). TAB is left out
	 * deliberately: it moves the cursor within the line and forges nothing.
	 */
	function assertNoForgedLine(text: string): void {
		assert.doesNotMatch(
			text,
			/^\[ghjig\] audit append OK/m,
			`a path component forged its own line into the degradation signal — a line asserting the trail is enforced sits inside the message that exists to say it is not: ${JSON.stringify(text)}`,
		);
		assert.doesNotMatch(
			text,
			/[\x00-\x08\x0a-\x1f\x7f-\x9f\u061c]/,
			`a control byte from a path component reached the operator surface unescaped: ${JSON.stringify(text)}`,
		);
		assert.doesNotMatch(
			text,
			/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/,
			`a bidi control or line/paragraph separator from a path component reached the operator surface raw — it reorders or breaks how the signal renders without ever matching a byte-class check: ${JSON.stringify(text)}`,
		);
	}

	it("a line break in a state-root component cannot forge a line into the degraded-append warning (AC1)", {
		skip: process.platform === "win32" ? "POSIX hostile bytes in path components" : false,
	}, () => {
		// The ENOENT arm carries the path twice — the open's own message as
		// the cause, and the recovery clause — and both halves must refuse
		// the forged line. Nothing is created at the hostile path: absent is
		// the very state that selects this arm.
		const base = mkdtempSync(join(tmpdir(), "ghjig-forge-lf-"));
		try {
			const { warnings } = captureWarnings(() => appendAuditRecord(join(base, FORGED, "state"), INPUT));
			assert.equal(warnings.length, 1, `expected one degradation warning, got ${JSON.stringify(warnings)}`);
			assert.match(warnings[0], /audit append failed/);
			assertNoForgedLine(warnings[0]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("control bytes in a state-root component cannot reach the degraded-append surface (AC2)", {
		skip: process.platform === "win32" ? "POSIX hostile bytes in path components" : false,
	}, () => {
		// Same surface, the ANSI shape: measured on PR #42's head as the byte
		// sequence [27,...] on the warning — enough to erase the disarmed-gate
		// line on any terminal that renders it.
		const base = mkdtempSync(join(tmpdir(), "ghjig-forge-ansi-"));
		try {
			const { warnings } = captureWarnings(() => appendAuditRecord(join(base, ANSI, "state"), INPUT));
			assert.equal(warnings.length, 1, `expected one degradation warning, got ${JSON.stringify(warnings)}`);
			assert.match(warnings[0], /audit append failed/);
			assertNoForgedLine(warnings[0]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("every recovery arm escapes the path it names, under both shapes (§3.11)", () => {
		// Called at the export, the same device the delayed-write arms use:
		// the codes whose failure no honest check can stage still owe a pin
		// on the text they emit. EACCES is staged separately below — its
		// guard probes the state root on disk.
		for (const shape of SHAPES) {
			const stateRoot = join(tmpdir(), "ghjig-forge-recovery", shape);
			const sinkPath = join(stateRoot, AUDIT_FILE_NAME);
			for (const code of ["ENOENT", "ENOTDIR", "ENOSPC", "EDQUOT", "EROFS", "EIO", "EUNMODELLED"]) {
				assertNoForgedLine(recoveryFor({ code }, stateRoot, sinkPath));
			}
		}
	});

	it("the destination-refuses-create arm escapes the directory it names (§3.11)", {
		skip: process.platform === "win32" ? "POSIX hostile bytes in path components" : false,
	}, () => {
		// The EACCES arm fires only when the state root measures as a
		// directory, so this is the one recovery arm whose hostile fixture
		// must really exist on disk.
		const base = mkdtempSync(join(tmpdir(), "ghjig-forge-eacces-"));
		try {
			for (const shape of SHAPES) {
				const stateRoot = join(base, shape);
				mkdirSync(stateRoot);
				const clause = recoveryFor({ code: "EACCES" }, stateRoot, join(stateRoot, AUDIT_FILE_NAME));
				assert.match(clause, /chmod u\+wx/, "the arm measures nothing unless the EACCES clause was selected");
				assertNoForgedLine(clause);
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("the sink-verdict refusal escapes the sink path in both cause and recovery (§4.6, §5.5)", {
		skip: process.platform === "win32" ? "POSIX device nodes and permission bits" : false,
	}, () => {
		// Direct call at the export with a hostile sink-path STRING — the
		// verdict never probes the path, so no hostile directory entry is
		// needed. Both recovery branches are exercised: the remove branch off
		// real /dev/null Stats (type, mode and owner all fail) and the
		// chmod-600 branch off a real loose-mode file this account owns
		// (mode is all that fails).
		const base = mkdtempSync(join(tmpdir(), "ghjig-forge-verdict-"));
		try {
			const statsOf = (path: string): Stats => {
				const fd = openSync(path, constants.O_RDONLY);
				try {
					return fstatSync(fd);
				} finally {
					closeSync(fd);
				}
			};
			const loosePath = join(base, "loose");
			writeFileSync(loosePath, "");
			chmodSync(loosePath, 0o644);
			for (const shape of SHAPES) {
				const sinkPath = join(base, shape, AUDIT_FILE_NAME);
				for (const stats of [statsOf("/dev/null"), statsOf(loosePath)]) {
					const refusal = sinkRefusal(stats, sinkPath);
					assert.ok(refusal !== undefined, "the arm measures nothing unless the fixture Stats are refused");
					assertNoForgedLine(refusal.cause);
					assertNoForgedLine(refusal.recovery);
				}
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("the subproject-.pi rejection warning escapes the directory it rejects (§4.7)", {
		skip: process.platform === "win32" ? "POSIX hostile bytes in path components" : false,
	}, () => {
		// This warning names a directory its own creator controls — the
		// actor the bound defends against (issue #47) — so the fixture
		// stages a hostile-named install root with a planted .pi below it.
		for (const shape of SHAPES) {
			const base = mkdtempSync(join(tmpdir(), "ghjig-forge-locate-"));
			try {
				const installDir = join(base, shape, ".pi", "extensions", "ghjig");
				mkdirSync(installDir, { recursive: true });
				const moduleFile = join(installDir, "locate.ts");
				writeFileSync(moduleFile, "// stand-in for the installed module\n");
				mkdirSync(join(installDir, ".pi"));
				const { warnings } = captureWarnings(() => locateRepoRootFrom(moduleFile));
				assert.equal(warnings.length, 1, `expected one rejection warning, got ${JSON.stringify(warnings)}`);
				assert.match(warnings[0], /it sits below the install root/);
				assertNoForgedLine(warnings[0]);
			} finally {
				rmSync(base, { recursive: true, force: true });
			}
		}
	});

	it("the discovery-failed warning escapes the module path it names (§3.9)", () => {
		// Nothing on this fixture path exists: every probe on the walk
		// answers absent, so the hostile bytes ride the moduleFile argument
		// into the warning without any directory entry on disk.
		for (const shape of SHAPES) {
			const moduleFile = join(tmpdir(), "ghjig-forge-missing", shape, "nested", "a", "b", "locate.ts");
			const { warnings } = captureWarnings(() => locateRepoRootFrom(moduleFile));
			assert.equal(warnings.length, 1, `expected one degradation warning, got ${JSON.stringify(warnings)}`);
			assert.match(warnings[0], /repo-root discovery failed/);
			assertNoForgedLine(warnings[0]);
		}
	});

	it("the relative-module refusal escapes the path it refuses (§4.6)", () => {
		for (const shape of SHAPES) {
			assert.throws(
				() => locateRepoRootFrom(shape),
				(error: unknown) => {
					assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
					assert.match(error.message, /cannot anchor the relative module path/);
					assertNoForgedLine(error.message);
					return true;
				},
			);
		}
	});

	it("both seam refusals escape the seam value they quote back (§3.9, §5.5)", () => {
		for (const shape of SHAPES) {
			// Relative → the not-absolute arm; the shapes carry no leading /.
			process.env[SEAM] = shape;
			assert.throws(
				() => resolveStateRoot(),
				(error: unknown) => {
					assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
					assert.match(error.message, /is set but not an absolute path/);
					assertNoForgedLine(error.message);
					return true;
				},
			);
			// Absolute but absent → the unusable arm; nothing is created.
			process.env[SEAM] = join(tmpdir(), "ghjig-forge-seam", shape);
			assert.throws(
				() => resolveStateRoot(),
				(error: unknown) => {
					assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
					assert.match(error.message, /is set but unusable/);
					assertNoForgedLine(error.message);
					return true;
				},
			);
		}
	});
});

describe("command-context recovery clauses are substitution-dead when pasted (issue #53)", () => {
	// Both arms RENDER a recovery clause for a sink path whose component
	// carries a command substitution — a shape POSIX admits in a directory
	// entry name and POSIX double quotes do not neutralize — then PERFORM
	// the paste the clause invites, in a shell whose working directory is
	// the fixture. The verdict is filesystem state, never the shell's exit
	// status: what must not happen is the substitution running; what must
	// still happen is the named repair landing on the literal path. The
	// hostile component reaches the shell through the clause under test and
	// through nothing else — every path here is composed with join(), never
	// spliced into a shell string by this suite.
	const SUBSTITUTION = "$(touch substitution-ran)";
	const MARKER = "substitution-ran";
	// Constructed, not inherited: the paste must behave the same on any
	// host, and the standard tool directories cover chmod, touch and rm.
	const PASTE_ENV = { PATH: "/usr/bin:/bin" };

	/** fstat of `path` through a descriptor, as the runtime's verdict reads it. */
	function statsOf(path: string): Stats {
		const fd = openSync(path, constants.O_RDONLY);
		try {
			return fstatSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Refuses a clause whose path operand leaves the fixture, whatever
	 * quoting style the clause carries. These arms perform the clause in a
	 * real shell, and the path it names is chosen by the function under
	 * test — a mutated clause naming a host path must be refused before
	 * the shell sees it, the same containment the recovery-performing arms
	 * above hold themselves to.
	 */
	function assertOperandInside(operand: string, fixture: string): void {
		const bare = operand.startsWith('"') || operand.startsWith("'") ? operand.slice(1) : operand;
		assert.ok(
			bare.startsWith(fixture + sep),
			`the clause's path operand ${operand} does not sit under the fixture at ${fixture}; this arm performs the clause in a shell and refuses to aim it anywhere the fixture does not own`,
		);
	}

	/** Runs `command` under bash in the fixture; the arm judges the filesystem, not the exit. */
	function paste(command: string, fixture: string): string {
		try {
			execFileSync("bash", ["-c", command], { cwd: fixture, env: PASTE_ENV });
			return "the shell exited 0";
		} catch (error) {
			return `the shell reported: ${String(error)}`;
		}
	}

	it("the mode arm's chmod clause repairs its literal object without executing a substitution-shaped component", {
		skip: process.platform === "win32" ? "POSIX shell paste" : false,
	}, () => {
		const base = mkdtempSync(join(tmpdir(), "ghjig-paste-chmod-"));
		try {
			// The literal hostile path really exists — the fs calls take the
			// name verbatim — with the loose mode that selects the chmod arm:
			// a regular file, one name, this account, group/other bits set.
			const sinkPath = join(base, SUBSTITUTION, AUDIT_FILE_NAME);
			mkdirSync(dirname(sinkPath));
			writeFileSync(sinkPath, "");
			chmodSync(sinkPath, 0o644);
			const refusal = sinkRefusal(statsOf(sinkPath), sinkPath);
			assert.ok(refusal !== undefined, "the arm measures nothing unless the fixture Stats are refused");
			const command = /`([^`]+)`/.exec(refusal.recovery)?.[1];
			assert.ok(
				command !== undefined && command.startsWith("chmod 600 "),
				`the arm measures nothing unless the backtick-quoted chmod command was selected: ${refusal.recovery}`,
			);
			assertOperandInside(command.slice("chmod 600 ".length), base);
			const outcome = paste(command, base);
			assert.ok(
				!existsSync(join(base, MARKER)),
				`pasting the clause executed the command substitution inside the path — the marker file appeared (${outcome}). The clause delimits the path for a shell paste, so the path must arrive substitution-dead`,
			);
			assert.equal(
				statSync(sinkPath).mode & 0o777,
				0o600,
				`the pasted chmod did not land on the literal sink path (${outcome}) — a clause whose repair misses its own object names a dead act`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("the general arm's remove clause deletes its literal object without executing a substitution-shaped component", {
		skip: process.platform === "win32" ? "POSIX shell paste" : false,
	}, () => {
		// This clause carries no backtick-quoted command — "remove" is prose
		// — so the pasteable unit under test is the delimited path operand,
		// in argument position after the rm the prose tells the operator to
		// run. That operand is exactly where the substitution rides.
		const base = mkdtempSync(join(tmpdir(), "ghjig-paste-remove-"));
		try {
			const sinkPath = join(base, SUBSTITUTION, AUDIT_FILE_NAME);
			mkdirSync(dirname(sinkPath));
			writeFileSync(sinkPath, "");
			// /dev/null Stats fail type, mode and owner at once, selecting
			// the general remove clause — the same real-kernel-object device
			// the sink-verdict arms use.
			const refusal = sinkRefusal(statsOf("/dev/null"), sinkPath);
			assert.ok(refusal !== undefined, "the arm measures nothing unless the fixture Stats are refused");
			const operand = /^remove (.+?), then re-run/.exec(refusal.recovery)?.[1];
			assert.ok(
				operand !== undefined,
				`the arm measures nothing unless the remove clause was selected: ${refusal.recovery}`,
			);
			assertOperandInside(operand, base);
			const outcome = paste(`rm -- ${operand}`, base);
			assert.ok(
				!existsSync(join(base, MARKER)),
				`pasting the clause's path operand executed the command substitution inside it — the marker file appeared (${outcome}). The clause delimits the path for a shell paste, so the operand must arrive substitution-dead`,
			);
			assert.ok(
				!existsSync(sinkPath),
				`the pasted remove did not land on the literal sink path (${outcome}) — a clause whose repair misses its own object names a dead act`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
