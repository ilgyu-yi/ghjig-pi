/**
 * Module-level integration suite for the dispatch instrument (issue #88;
 * SPEC §4.9 "The delegation layer" — home `.pi/extensions/gitjig/dispatch/`;
 * §1.5 tree isolation; §1.6's pin-at-provision clause; §3.10's five-class
 * fail-closed set; §3.9's content-free refusal records).
 *
 * The modules are imported DIRECTLY through a guarded dynamic import, and
 * every arm's first assertion is the authored subject-absence anchor: the
 * dispatch directory does not exist on this tree, so each arm reds on
 * "nothing to measure" with its own message while every sibling suite
 * survives (a top-level static import of a missing module would abort the
 * whole file and erase the authored messages). Fixture repositories are
 * minted inline — `mkdtemp` + `git init -q -b main` + per-command
 * `-c user.name/-c user.email/-c commit.gpgsign=false` (the host has
 * commit signing configured against an unsignable throwaway identity, so
 * the gpgsign flag is mandatory on every commit, the delegate's included).
 *
 * AUTHORED PHASE-C CONTRACT (what these arms bind to):
 *
 *   `dispatch/provision.ts`
 *     - `provisionDispatchContext(callerRepoRoot, { brief, expectedRef? })`
 *       (sync or async — the suite awaits either): resolves the ref ONCE in
 *       the caller's repository (`expectedRef` is a ref NAME; absent, the
 *       caller's HEAD), holds the hash, `clone --no-hardlinks` into a
 *       `mkdtempSync` scratch, `checkout --detach <held-hash>` — the
 *       provisioned tree equals the held operand by construction (§4.9's
 *       pin-at-provision paragraph). Scratch layout, path-pinned on the
 *       returned context: `tree/  brief.md  return.json  state/` —
 *       `treeDir`, `briefPath` (carrying the brief), `returnPath`,
 *       `stateDir`, plus `scratchRoot` and the held `heldHash`.
 *     - an `expectedRef` naming no object in the caller repository fails
 *       LOUD (throws/rejects), never a silent context.
 *     - `cleanupDispatchContext(context)` removes the scratch.
 *
 *   `dispatch/executor.ts`
 *     - `runDelegate(context, argv, { timeoutMs? })` → `Promise<{ exitCode,
 *       timedOut }>`: a delegate-agnostic argv child, cwd pinned to the
 *       provisioned tree, both streams drained, parent environment passed
 *       through with the one state seam rebound —
 *       `GITJIG_TEST_STATE_ROOT=<scratch>/state` (§5.5's disposable-root
 *       carve-out, pointed inside the scratch).
 *     - the delegate reaches the return file at `../return.json` from its
 *       tree cwd — layout-derived, no second locator surface.
 *
 *   `dispatch/index.ts`
 *     - `runDispatch({ callerRepoRoot, stateRoot, brief, delegateArgv,
 *       expectedRef?, timeoutMs? })` → the composed pipeline (provision →
 *       run → admit → cleanup in `finally`), returning either
 *       `{ disposition: "admitted", ok, summary, compare? }` or
 *       `{ disposition: "refused", cause }`; `registerDispatchTool` wraps
 *       it (that registration surface is the sibling pi suite's subject).
 *     - admission: `return.json` is the sole crossing; ≤ 64 KiB (an
 *       oversize return is refused WHOLE, never truncated and admitted);
 *       closed schema `{ok: boolean, summary: string, reviewedHead?}` —
 *       unknown keys refused; §3.10's five outcome classes (delegate
 *       absent, failed run, junk output, partial output, payload on the
 *       wrong stream) each refuse on a fixed content-free cause.
 *     - compare: a `reviewedHead` in the return is CONSUMED and surfaced
 *       as validity alone — `compare: "confirmed"` iff it equals the held
 *       hash, else `"invalid"` — and the return/failure channels stay
 *       content-free with respect to the caller-held operands: no hex run
 *       of ≥ 7 chars prefixing the held hash on any outgoing surface, and
 *       a summary carrying one is REFUSED whole (the mechanical scan §4.9
 *       grounds in §3.9's content-free idiom).
 *     - every refusal lands at least one `"category":"dispatch"` audit
 *       record through the landed writer (`audit.ts`), itself content-free.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. Concurrent-provision distinctness is
 * BEHAVIORAL evidence of the mkdtemp primitive's exclusivity guarantee,
 * never a proof of atomicity — three racing provisions landing three
 * distinct paths is what the primitive promises, and this suite measures
 * the promise's visible face only. The ≥7-hex-prefix scan pins the
 * MECHANICAL rule alone: a delegate paraphrasing the held hash in prose,
 * or encoding it outside a hex run, is §4.9's injectable-context residual,
 * not this suite's subject. The five §3.10 classes are staged by OUTCOME
 * SHAPE, not cause — which syscall failed inside a shim is not measured,
 * only what the dispatcher admitted. `clone --no-hardlinks` is asserted
 * behaviorally (delegate mutations invisible to the caller), never as a
 * flag spelling; the cleanup's degrade-open audit warn (an unremovable
 * scratch) and the executor's two-timers-one-phase-each split are not
 * staged. Isolation is measured against a MUTATING delegate that commits
 * and writes in its clone; a delegate that pushes to its origin remote is
 * outside these arms.
 *
 * Mutants, both directions, per matcher: the pin arms hold a branch ref
 * against an advanced HEAD and the default HEAD against itself, so a
 * resolve-at-run-time mutant reddens at wrong-tree and a resolve-nothing
 * mutant at the pin arms; admission drives valid → admitted AND every
 * refusal class → refused, so always-admit and always-refuse both redden;
 * the scan drives a held-hash prefix → refused AND an unrelated 7-hex run
 * → admitted; compare drives a computed head → confirmed AND a misreported
 * head → invalid. Control bytes ride generator escapes only — the
 * stream-flood arm fills through `yes | head -c`, no literal control byte
 * enters a script.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const DISPATCH_DIR = join(repoRoot(), ".pi", "extensions", "gitjig", "dispatch");

/** The authored red-anchor message every subject-absence arm carries. */
function redUntilLanded(moduleName: string, arm: string, failure: string): string {
	return (
		`${arm}: red until the Code phase lands \`.pi/extensions/gitjig/dispatch/${moduleName}\` ` +
		`(issue #88; SPEC §4.9's home clause) — the guarded dynamic import found nothing to measure: ${failure}`
	);
}

// ---------------------------------------------------------------------------
// The authored module contracts (types local to the suite: the modules do
// not exist yet, so the suite carries the shapes it binds Phase C to).
// ---------------------------------------------------------------------------

interface DispatchContext {
	scratchRoot: string;
	treeDir: string;
	briefPath: string;
	returnPath: string;
	stateDir: string;
	heldHash: string;
}

interface ProvisionModule {
	provisionDispatchContext(
		callerRepoRoot: string,
		options: { brief: string; expectedRef?: string },
	): DispatchContext | Promise<DispatchContext>;
	cleanupDispatchContext(context: DispatchContext): unknown;
}

interface ExecutorModule {
	runDelegate(
		context: DispatchContext,
		argv: string[],
		options?: { timeoutMs?: number },
	): Promise<{ exitCode: number | null; timedOut: boolean }>;
}

type DispatchOutcome =
	| { disposition: "admitted"; ok: boolean; summary: string; compare?: "confirmed" | "invalid" }
	| { disposition: "refused"; cause: string };

interface IndexModule {
	runDispatch(options: {
		callerRepoRoot: string;
		stateRoot: string;
		brief: string;
		delegateArgv: string[];
		expectedRef?: string;
		timeoutMs?: number;
	}): Promise<DispatchOutcome>;
	registerDispatchTool(pi: unknown, repoRoot: string, stateRoot: string): void;
	DISPATCH_TOOL_NAME: string;
}

type Imported<T> = { module: T } | { failure: string };

async function importDispatch<T>(moduleName: string): Promise<Imported<T>> {
	try {
		return { module: (await import(pathToFileURL(join(DISPATCH_DIR, moduleName)).href)) as T };
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

/** Import-or-red: the arm's subject-absence anchor, one call per module. */
async function requireModule<T>(moduleName: string, arm: string): Promise<T> {
	const loaded = await importDispatch<T>(moduleName);
	assert.ok("module" in loaded, redUntilLanded(moduleName, arm, "failure" in loaded ? loaded.failure : ""));
	return (loaded as { module: T }).module;
}

// ---------------------------------------------------------------------------
// Inline fixture repositories (the harness is read-only; repos mint here).
// ---------------------------------------------------------------------------

const cleanups: string[] = [];

after(() => {
	for (const dir of cleanups) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function mintDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

/** Throwaway identity + mandatory unsigned commits (measured host shape). */
const GIT_FLAGS = ["-c", "user.name=zq", "-c", "user.email=zq@zq.zq", "-c", "commit.gpgsign=false"];

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...GIT_FLAGS, ...args], { encoding: "utf8" });
}

function mintRepo(files: Record<string, string> = {}): string {
	const repo = mintDir("gitjig-dispatch-caller-");
	execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
	writeFileSync(join(repo, "zq-base.txt"), "zq base content\n");
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(repo, name), content);
	}
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "zq dispatch fixture commit");
	return repo;
}

function headOf(repo: string): string {
	return git(repo, "rev-parse", "HEAD").trim();
}

/** One more commit on the current branch; returns the new tip. */
function advance(repo: string): string {
	writeFileSync(join(repo, "zq-advance.txt"), "zq advanced content\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "zq advance commit");
	return headOf(repo);
}

const BRIEF = "zq dispatch brief: perform the staged act and write the bounded return";

// ---------------------------------------------------------------------------
// Committed return payloads (the delegate `cp`s them into ../return.json,
// so every returned byte crossed as tree content, never as script quoting).
// ---------------------------------------------------------------------------

const RETURN_LIMIT = 64 * 1024;
const CLEAN_SUMMARY = "zqdispatch clean bounded summary";
const JUNK_MARKER = "ZQJUNKRETURNBYTES";
const PARTIAL_MARKER = "ZQPARTIALRETURNBYTES";
const UNKNOWN_MARKER = "ZQUNKNOWNKEYVALUE";
const OVERSIZE_MARKER = "ZQOVERSIZERETURNMARK";
const STREAM_MARKER = "ZQDELEGATESTREAMBYTES";
const MISREPORTED_HEAD = "f".repeat(40);

const PAYLOADS: Record<string, string> = {
	"payload-valid.json": `{"ok":true,"summary":"${CLEAN_SUMMARY}"}`,
	"payload-junk.json": `${JUNK_MARKER} not json at all\n`,
	"payload-partial.json": `{"ok":true,"summary":"${PARTIAL_MARKER}`,
	"payload-unknown.json": `{"ok":true,"summary":"zq","zqExtraKey":"${UNKNOWN_MARKER}"}`,
	"payload-oversize.json": `{"ok":true,"summary":"${OVERSIZE_MARKER}${"z".repeat(RETURN_LIMIT)}"}`,
	"payload-misreported-head.json":
		`{"ok":true,"summary":"zqcompare misreported summary","reviewedHead":"${MISREPORTED_HEAD}"}`,
	"payload-unrelated-hex.json": `{"ok":true,"summary":"zq run alongside deadbee7 stays inert"}`,
};

/** Delegate scripts, run as `sh -c` with cwd = the provisioned tree. */
const COPY = (payload: string): string => `cp ${payload} ../return.json`;
const SCRIPT_FAILED_RUN = `printf '%s' ${STREAM_MARKER}ERR >&2; exit 7`;
const SCRIPT_WRONG_STREAM = `cat payload-valid.json && printf '%s' ${STREAM_MARKER}OUT`;
const SCRIPT_REVIEWED_HEAD =
	"printf '{\"ok\":true,\"summary\":\"zqcompare confirmed summary\",\"reviewedHead\":\"%s\"}' " +
	'"$(git rev-parse HEAD)" > ../return.json';
const SCRIPT_HELD_PREFIX =
	"printf '{\"ok\":true,\"summary\":\"zq work landed at %s today\"}' " +
	'"$(git rev-parse --short=7 HEAD)" > ../return.json';
const SCRIPT_MUTATE =
	"printf 'zq intruder bytes' > zq-intruder.txt && git add zq-intruder.txt && " +
	"git -c user.name=zq -c user.email=zq@zq.zq -c commit.gpgsign=false commit -q -m 'zq delegate commit' && " +
	"git branch zq-delegate-branch && git rev-parse HEAD > zq-mutated-head";
const SCRIPT_OBSERVE_HEAD = "git rev-parse HEAD > zq-observed-head";
const SCRIPT_SEAM_CAPTURE = 'printf \'%s\' "$GITJIG_TEST_STATE_ROOT" > zq-seam-capture';
const SCRIPT_STREAM_FLOOD = "yes zqstreamfill | head -c 3000000 && yes zqstreamfill | head -c 3000000 >&2";

// ---------------------------------------------------------------------------
// Audit + refusal helpers.
// ---------------------------------------------------------------------------

interface AuditSink {
	stateRoot: string;
	auditFile: string;
}

function mintStateRoot(): AuditSink {
	const stateRoot = mintDir("gitjig-dispatch-state-");
	return { stateRoot, auditFile: join(stateRoot, "audit.jsonl") };
}

function auditLines(sink: AuditSink): string[] {
	if (!existsSync(sink.auditFile)) {
		return [];
	}
	return readFileSync(sink.auditFile, "utf8").split("\n").filter((line) => line !== "");
}

function dispatchAuditLines(sink: AuditSink): string[] {
	return auditLines(sink).filter((line) => line.includes('"category":"dispatch"'));
}

/**
 * The refusal verdict every §3.10 class arm holds its outcome to: refused
 * (never admitted, never truncated-into-admitted), a non-empty fixed cause,
 * a `"category":"dispatch"` audit record, and every guarded byte string —
 * delegate stream bytes, return-payload markers, the held-hash prefix —
 * absent from the outcome AND the whole audit trail (§3.9's content-free
 * refusal records; §4.9's content-free return channels).
 */
function assertRefusedContentFree(
	outcome: DispatchOutcome,
	sink: AuditSink,
	guarded: Array<[string, string]>,
	arm: string,
): void {
	assert.equal(
		outcome.disposition,
		"refused",
		`${arm}: §3.10 admits on output validity alone and enumerates this outcome class as fail-closed — ` +
			`the dispatch must refuse, got ${JSON.stringify(outcome)}`,
	);
	const cause = (outcome as { disposition: "refused"; cause: string }).cause;
	assert.ok(
		typeof cause === "string" && cause.length > 0,
		`${arm}: the refusal carries no cause — a refusal owes its fixed content-free cause (§3.9, §3.11)`,
	);
	assert.ok(
		dispatchAuditLines(sink).length >= 1,
		`${arm}: no "category":"dispatch" audit record landed for the refusal — the dispatcher's acts ride the ` +
			`landed writer (issue #88 authored contract; §5.5); audit: ${JSON.stringify(auditLines(sink))}`,
	);
	const outcomeBytes = JSON.stringify(outcome);
	for (const [bytes, what] of guarded) {
		assert.ok(
			!outcomeBytes.includes(bytes),
			`${arm}: ${what} ('${bytes.slice(0, 24)}') reached the dispatch outcome — the return and failure ` +
				`channels are content-free (§4.9)`,
		);
		for (const line of auditLines(sink)) {
			assert.ok(
				!line.includes(bytes),
				`${arm}: ${what} ('${bytes.slice(0, 24)}') reached the audit trail (§3.8's refusal-record rule)`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Provision: pin-at-provision, layout, loud absence, distinctness, cleanup.
// ---------------------------------------------------------------------------

describe("provision pins the tree at the once-resolved hash (issue #88, SPEC §4.9)", () => {
	it("pin-with-expectedRef: the tree detaches at the ref's resolved hash, not the advanced branch tip", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "pin-with-expectedRef");
		const repo = mintRepo();
		git(repo, "branch", "zq-pin");
		const pinned = headOf(repo);
		const advanced = advance(repo);
		assert.notEqual(pinned, advanced, "fixture defect: the advance commit did not move the branch tip");
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF, expectedRef: "zq-pin" });
		cleanups.push(context.scratchRoot);
		assert.equal(
			context.heldHash,
			pinned,
			"pin-with-expectedRef: the held hash is not the caller-repository resolution of the named ref — " +
				"provision resolves exactly once, in the caller's repository (§4.9 pin-at-provision)",
		);
		assert.equal(
			git(context.treeDir, "rev-parse", "HEAD").trim(),
			pinned,
			"pin-with-expectedRef: the provisioned tree's HEAD is not the held hash — the tree must equal the " +
				"held operand by construction (§4.9)",
		);
		assert.equal(
			git(context.treeDir, "rev-parse", "--abbrev-ref", "HEAD").trim(),
			"HEAD",
			"pin-with-expectedRef: the tree is on a branch, not detached at the held hash — a branch re-resolves",
		);
	});

	it("pin-default-HEAD: with no expectedRef the caller's HEAD is held and provisioned", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "pin-default-HEAD");
		const repo = mintRepo();
		const held = headOf(repo);
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF });
		cleanups.push(context.scratchRoot);
		assert.equal(context.heldHash, held, "pin-default-HEAD: the held hash is not the caller's HEAD at provision");
		assert.equal(
			git(context.treeDir, "rev-parse", "HEAD").trim(),
			held,
			"pin-default-HEAD: the provisioned tree's HEAD is not the held hash (§4.9 pin-at-provision)",
		);
	});

	it("layout: the scratch carries tree/, brief.md (the brief's bytes), state/, and the pinned return path", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "layout");
		const repo = mintRepo();
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF });
		cleanups.push(context.scratchRoot);
		assert.equal(context.treeDir, join(context.scratchRoot, "tree"), "layout: treeDir is not <scratch>/tree");
		assert.equal(context.briefPath, join(context.scratchRoot, "brief.md"), "layout: briefPath is not <scratch>/brief.md");
		assert.equal(
			context.returnPath,
			join(context.scratchRoot, "return.json"),
			"layout: returnPath is not <scratch>/return.json — the sole crossing must sit at the layout's slot",
		);
		assert.equal(context.stateDir, join(context.scratchRoot, "state"), "layout: stateDir is not <scratch>/state");
		assert.ok(statSync(context.treeDir).isDirectory(), "layout: tree/ is not a directory");
		assert.ok(statSync(context.stateDir).isDirectory(), "layout: state/ is not a directory");
		assert.equal(
			readFileSync(context.briefPath, "utf8"),
			BRIEF,
			"layout: brief.md does not carry the dispatched brief's bytes (§1.5's dispatch-facts carrier)",
		);
	});

	it("wrong-tree: the caller's branch advances after provision; the delegate still acts at the held hash", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "wrong-tree");
		const executor = await requireModule<ExecutorModule>("executor.ts", "wrong-tree");
		const repo = mintRepo();
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF, expectedRef: "main" });
		cleanups.push(context.scratchRoot);
		const held = context.heldHash;
		const advanced = advance(repo);
		assert.notEqual(held, advanced, "fixture defect: the post-provision advance did not move the branch");
		const outcome = await executor.runDelegate(context, ["sh", "-c", SCRIPT_OBSERVE_HEAD], { timeoutMs: 30_000 });
		assert.equal(outcome.exitCode, 0, "wrong-tree: the observing delegate failed to run");
		assert.equal(
			readFileSync(join(context.treeDir, "zq-observed-head"), "utf8").trim(),
			held,
			"wrong-tree: the delegate observed a HEAD other than the held hash — the pin binds at provision, " +
				"and nothing at run time may re-resolve the ref (§4.9 pin-at-provision; §1.6)",
		);
	});

	it("absent-object: an expectedRef naming nothing in the caller repository fails loud", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "absent-object");
		const repo = mintRepo();
		let refusal: unknown;
		try {
			const context = await provision.provisionDispatchContext(repo, { brief: BRIEF, expectedRef: "zq-absent-ref" });
			cleanups.push(context.scratchRoot);
		} catch (error) {
			refusal = error;
		}
		assert.ok(
			refusal !== undefined,
			"absent-object: provision produced a context for a ref that resolves to nothing — an unresolvable " +
				"expected head is ambiguity and fails loud, never a silently-provisioned tree (§3.9)",
		);
	});

	it("concurrent provisions land distinct scratch paths (mkdtemp exclusivity, behavioral)", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "concurrency");
		const repo = mintRepo();
		const held = headOf(repo);
		const contexts = await Promise.all([
			provision.provisionDispatchContext(repo, { brief: BRIEF }),
			provision.provisionDispatchContext(repo, { brief: BRIEF }),
			provision.provisionDispatchContext(repo, { brief: BRIEF }),
		]);
		for (const context of contexts) {
			cleanups.push(context.scratchRoot);
		}
		assert.equal(
			new Set(contexts.map((context) => context.scratchRoot)).size,
			3,
			"concurrency: two provisions share a scratch path — mkdtemp's exclusive creation is the isolation " +
				"floor two racing dispatches stand on (§1.5)",
		);
		for (const context of contexts) {
			assert.equal(
				git(context.treeDir, "rev-parse", "HEAD").trim(),
				held,
				"concurrency: a racing provision landed a tree off the held hash",
			);
		}
	});

	it("cleanup removes the scratch", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "cleanup");
		const repo = mintRepo();
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF });
		cleanups.push(context.scratchRoot);
		assert.ok(existsSync(context.scratchRoot), "cleanup: no scratch to remove — provision produced nothing");
		await provision.cleanupDispatchContext(context);
		assert.ok(
			!existsSync(context.scratchRoot),
			"cleanup: the scratch survives — a dispatch that accumulates clones leaks the caller's history " +
				"into an unmanaged surface (§1.5's bounded distillation; §4.9)",
		);
	});
});

// ---------------------------------------------------------------------------
// Isolation: the delegate's acts stay inside its clone.
// ---------------------------------------------------------------------------

describe("a mutating delegate is invisible to the caller repository (issue #88, SPEC §1.5)", () => {
	it("delegate commits, writes, and branches in its clone; the caller's tree AND refs are unchanged", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "mutation-invisibility");
		const executor = await requireModule<ExecutorModule>("executor.ts", "mutation-invisibility");
		const repo = mintRepo();
		const held = headOf(repo);
		const refsBefore = git(repo, "for-each-ref");
		const porcelainBefore = git(repo, "status", "--porcelain");
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF });
		cleanups.push(context.scratchRoot);
		const outcome = await executor.runDelegate(context, ["sh", "-c", SCRIPT_MUTATE], { timeoutMs: 30_000 });
		assert.equal(outcome.exitCode, 0, "mutation-invisibility: the mutating delegate failed — the arm is vacuous");
		assert.notEqual(
			readFileSync(join(context.treeDir, "zq-mutated-head"), "utf8").trim(),
			held,
			"mutation-invisibility: the delegate's commit did not land in its clone — the arm is vacuous",
		);
		assert.equal(
			headOf(repo),
			held,
			"mutation-invisibility: the caller's HEAD moved — the delegate's commit escaped its clone (§1.5)",
		);
		assert.equal(
			git(repo, "for-each-ref"),
			refsBefore,
			"mutation-invisibility: the caller's refs changed — a delegate branch or commit crossed the isolation " +
				"boundary (§1.5; the clone is the delegate's whole writable world)",
		);
		assert.equal(
			git(repo, "status", "--porcelain"),
			porcelainBefore,
			"mutation-invisibility: the caller's working tree changed under a dispatched delegate (§1.5)",
		);
	});
});

// ---------------------------------------------------------------------------
// Executor: drained streams; the state seam inside the scratch.
// ---------------------------------------------------------------------------

describe("the executor's child is drained and seam-scoped (issue #88, SPEC §4.9)", () => {
	it("streams drained: a delegate flooding both streams completes instead of wedging on a full pipe", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "streams-drained");
		const executor = await requireModule<ExecutorModule>("executor.ts", "streams-drained");
		const repo = mintRepo();
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF });
		cleanups.push(context.scratchRoot);
		const outcome = await executor.runDelegate(context, ["sh", "-c", SCRIPT_STREAM_FLOOD], { timeoutMs: 60_000 });
		assert.equal(
			outcome.timedOut,
			false,
			"streams-drained: the flooding delegate hit the bound — an undrained pipe wedges the child at the " +
				"kernel buffer and the timer converts a deadlock into a timeout instead of a run (§4.9)",
		);
		assert.equal(outcome.exitCode, 0, "streams-drained: the flooding delegate did not complete cleanly");
	});

	it("the delegate's state seam points at <scratch>/state, inside the scratch", async () => {
		const provision = await requireModule<ProvisionModule>("provision.ts", "state-seam");
		const executor = await requireModule<ExecutorModule>("executor.ts", "state-seam");
		const repo = mintRepo();
		const context = await provision.provisionDispatchContext(repo, { brief: BRIEF });
		cleanups.push(context.scratchRoot);
		const outcome = await executor.runDelegate(context, ["sh", "-c", SCRIPT_SEAM_CAPTURE], { timeoutMs: 30_000 });
		assert.equal(outcome.exitCode, 0, "state-seam: the capturing delegate failed to run");
		const captured = readFileSync(join(context.treeDir, "zq-seam-capture"), "utf8");
		assert.equal(
			captured,
			context.stateDir,
			"state-seam: the delegate's GITJIG_TEST_STATE_ROOT is not the context's state dir — a delegate " +
				"writing shell state anywhere but the scratch pollutes the caller's evidence surface (§5.5)",
		);
		assert.ok(
			captured.startsWith(context.scratchRoot + sep),
			"state-seam: the seam target sits outside the scratch — the delegate's state must die with the " +
				"dispatch (§5.5's disposable-root carve-out)",
		);
	});
});

// ---------------------------------------------------------------------------
// Admission: the bounded return, both directions.
// ---------------------------------------------------------------------------

describe("admission: return.json is the sole, bounded, closed-schema crossing (issue #88, SPEC §3.10)", () => {
	it("a valid return is admitted with its summary intact (the allow direction)", async () => {
		const index = await requireModule<IndexModule>("index.ts", "valid-return");
		const repo = mintRepo(PAYLOADS);
		const held = headOf(repo);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-valid.json")],
			timeoutMs: 30_000,
		});
		assert.equal(
			outcome.disposition,
			"admitted",
			`valid-return: a well-formed in-schema return was refused — an always-refuse dispatcher is the ` +
				`mutant this direction kills (§3.10): ${JSON.stringify(outcome)}`,
		);
		const admitted = outcome as { disposition: "admitted"; ok: boolean; summary: string };
		assert.equal(admitted.ok, true, "valid-return: the return's ok flag did not survive admission");
		assert.equal(admitted.summary, CLEAN_SUMMARY, "valid-return: the bounded summary did not cross back intact");
		assert.ok(
			!JSON.stringify(outcome).includes(held.slice(0, 7)),
			"valid-return: the admitted outcome carries the held hash — the return channel is content-free " +
				"with respect to caller-held operands (§4.9)",
		);
	});

	it("an oversize return (> 64 KiB) is refused whole, never truncated into an admission", async () => {
		const index = await requireModule<IndexModule>("index.ts", "oversize-return");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-oversize.json")],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[
				[OVERSIZE_MARKER, "the oversize return's bytes"],
				[headOf(repo).slice(0, 7), "the held hash's prefix"],
			],
			"oversize-return",
		);
	});

	it("§3.10 junk output: a non-JSON return refuses on a fixed content-free cause", async () => {
		const index = await requireModule<IndexModule>("index.ts", "junk-return");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-junk.json")],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[
				[JUNK_MARKER, "the junk return's bytes"],
				[headOf(repo).slice(0, 7), "the held hash's prefix"],
			],
			"junk-return",
		);
	});

	it("§3.10 partial output: a truncated return refuses — a weaker parse is a second implementation", async () => {
		const index = await requireModule<IndexModule>("index.ts", "partial-return");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-partial.json")],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[
				[PARTIAL_MARKER, "the partial return's bytes"],
				[headOf(repo).slice(0, 7), "the held hash's prefix"],
			],
			"partial-return",
		);
	});

	it("an unknown key refuses — the schema is closed, not minimum-matched", async () => {
		const index = await requireModule<IndexModule>("index.ts", "unknown-key");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-unknown.json")],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[
				[UNKNOWN_MARKER, "the unknown key's value bytes"],
				[headOf(repo).slice(0, 7), "the held hash's prefix"],
			],
			"unknown-key",
		);
	});

	it("§3.10 failed run: a non-zero delegate writing no return refuses, its streams excluded", async () => {
		const index = await requireModule<IndexModule>("index.ts", "failed-run");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", SCRIPT_FAILED_RUN],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[
				[STREAM_MARKER, "delegate stream bytes"],
				[headOf(repo).slice(0, 7), "the held hash's prefix"],
			],
			"failed-run",
		);
	});

	it("§3.10 delegate absent: an unspawnable delegate refuses with a record, never a wedge", async () => {
		const index = await requireModule<IndexModule>("index.ts", "delegate-absent");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: [join(repo, "zq-absent-delegate")],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(outcome, sink, [[headOf(repo).slice(0, 7), "the held hash's prefix"]], "delegate-absent");
	});

	it("§3.10 wrong stream: a valid return printed on stdout is not the crossing — refused", async () => {
		const index = await requireModule<IndexModule>("index.ts", "wrong-stream");
		const repo = mintRepo(PAYLOADS);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", SCRIPT_WRONG_STREAM],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[
				[STREAM_MARKER, "delegate stream bytes"],
				[CLEAN_SUMMARY, "the stream-borne summary's bytes"],
				[headOf(repo).slice(0, 7), "the held hash's prefix"],
			],
			"wrong-stream",
		);
	});
});

// ---------------------------------------------------------------------------
// Compare + the outgoing-surface operand scan, both directions each.
// ---------------------------------------------------------------------------

describe("the blind compare and the operand scan (issue #88, SPEC §4.9, §1.6)", () => {
	it("a reviewedHead equal to the held hash surfaces compare 'confirmed', naming no operand", async () => {
		const index = await requireModule<IndexModule>("index.ts", "compare-confirmed");
		const repo = mintRepo(PAYLOADS);
		const held = headOf(repo);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", SCRIPT_REVIEWED_HEAD],
			expectedRef: "main",
			timeoutMs: 30_000,
		});
		assert.equal(
			outcome.disposition,
			"admitted",
			`compare-confirmed: the in-schema return was refused: ${JSON.stringify(outcome)}`,
		);
		assert.equal(
			(outcome as { compare?: string }).compare,
			"confirmed",
			"compare-confirmed: a reviewedHead equal to the held hash did not surface as 'confirmed' — the " +
				"caller consumes validity, never the operand pair (§1.6's blind compare via §4.9)",
		);
		assert.ok(
			!JSON.stringify(outcome).includes(held.slice(0, 7)),
			"compare-confirmed: the outcome names the held operand — the compare crosses back as validity " +
				"alone (§4.9's content-free return channels)",
		);
	});

	it("a misreported reviewedHead surfaces compare 'invalid' — never tree drift, and neither value crosses", async () => {
		const index = await requireModule<IndexModule>("index.ts", "compare-invalid");
		const repo = mintRepo(PAYLOADS);
		const held = headOf(repo);
		assert.ok(
			!held.startsWith(MISREPORTED_HEAD.slice(0, 7)),
			"compare-invalid: improbable fixture collision — the minted head shares the staged operand's prefix; re-run",
		);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-misreported-head.json")],
			expectedRef: "main",
			timeoutMs: 30_000,
		});
		assert.equal(
			outcome.disposition,
			"admitted",
			`compare-invalid: the in-schema return was refused outright — the compare's verdict, not a schema ` +
				`refusal, is what the merge-review row consumes: ${JSON.stringify(outcome)}`,
		);
		assert.equal(
			(outcome as { compare?: string }).compare,
			"invalid",
			"compare-invalid: a reviewedHead differing from the held hash did not surface as 'invalid' — with " +
				"the tree pinned at provision, a misreported return is the ONLY way this compare can fail, and " +
				"an always-confirmed dispatcher forges the merge-review row's evidence (§4.9, §3.3)",
		);
		const outcomeBytes = JSON.stringify(outcome);
		assert.ok(
			!outcomeBytes.includes(held.slice(0, 7)) && !outcomeBytes.includes(MISREPORTED_HEAD.slice(0, 7)),
			"compare-invalid: the outcome names a compare operand — validity alone crosses back, never either " +
				"value (§4.9's content-free return channels)",
		);
	});

	it("a summary carrying a ≥7-hex prefix of the held hash is refused whole (the scan's refuse direction)", async () => {
		const index = await requireModule<IndexModule>("index.ts", "held-prefix-scan");
		const repo = mintRepo(PAYLOADS);
		const held = headOf(repo);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", SCRIPT_HELD_PREFIX],
			timeoutMs: 30_000,
		});
		assertRefusedContentFree(
			outcome,
			sink,
			[[held.slice(0, 7), "the held hash's prefix"]],
			"held-prefix-scan",
		);
	});

	it("an unrelated 7-hex run in the summary is admitted (the scan's allow direction)", async () => {
		const index = await requireModule<IndexModule>("index.ts", "unrelated-hex");
		const repo = mintRepo(PAYLOADS);
		const held = headOf(repo);
		assert.ok(
			!held.startsWith("deadbee"),
			"unrelated-hex: improbable fixture collision — the minted head starts with the staged hex run; re-run",
		);
		const sink = mintStateRoot();
		const outcome = await index.runDispatch({
			callerRepoRoot: repo,
			stateRoot: sink.stateRoot,
			brief: BRIEF,
			delegateArgv: ["sh", "-c", COPY("payload-unrelated-hex.json")],
			timeoutMs: 30_000,
		});
		assert.equal(
			outcome.disposition,
			"admitted",
			`unrelated-hex: a summary whose hex run prefixes nothing the caller holds was refused — the scan ` +
				`pins the held operand, not hex at large, and an over-blocking scan makes every hash-adjacent ` +
				`summary undeliverable (§3.11's recoverable-false-block asymmetry still costs a round): ` +
				`${JSON.stringify(outcome)}`,
		);
		assert.equal(
			(outcome as { summary?: string }).summary,
			"zq run alongside deadbee7 stays inert",
			"unrelated-hex: the admitted summary did not cross back intact",
		);
	});
});
