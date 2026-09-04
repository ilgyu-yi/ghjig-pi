/**
 * Session-start bind advisory — the tier-2 arming detector (SPEC §5.2
 * advisory state set, §5.9 read-only detector rule, §4.6 detector
 * placement).
 *
 * The detector reproduces the consumer's RESOLUTION and not the consumer's
 * EXECUTION: it answers from the configuration git itself resolves
 * (`core.hooksPath`, every scope merged — what fires is what git resolves)
 * and the layout the adapters derive from it (`<top>/.githooks`), running
 * no program of the repository it is classifying. A classifier that
 * executed what it classifies would not be the read-only surface §5.2
 * places it in.
 *
 * Placement (§4.6): the repository the advisory speaks about is the one
 * the SESSION stands in, resolved through `git rev-parse --show-toplevel`
 * from the session cwd — never `locateRepoRoot()`, whose realpath
 * resolution follows a symlinked install back to the real tree and would
 * classify the wrong clone (a linked worktree must be classified at ITS
 * top, where the adapters resolve). `locateRepoRoot()` names, with no test
 * seam set, the state root the TTL stamp lands under, since
 * `resolveStateRoot()` derives it from that same root: the debounce is
 * therefore keyed to the EXTENSION's repository while classification is
 * keyed to the session cwd. The two coincide in every shipped shape (the
 * extension is loaded from the clone the session stands in).
 *
 * The module's own READ of the TTL stamp goes through `readGatedFile`: open
 * the path under `audit.ts`'s guard flags, then require a plain regular file
 * inside a size cap OF THE DESCRIPTOR that open returned. The child timeout
 * bounds only SPAWNED children, and this process's own read has nothing to
 * reap — an unguarded open on a FIFO (or a symlink to one) at a read path
 * parks session start indefinitely, and a huge blob allocates against it.
 *
 * The WRITE side is split by what each component can be. The DIRECTORY
 * components — the state root's container and the state root — are
 * lstat-refused when they are links, because `mkdirSync(…, {recursive:
 * true})` follows a directory-level link and a link at the root routes the
 * stamp into the planter's directory; they are created with an owner-only
 * mode, since this writer is ordinarily the first to materialize the
 * shell's namespace and no later run tightens what it minted (§5.5). The
 * stamp LEAF is not probed and then written: it is OPENED under
 * `audit.ts`'s exported guard flags and its descriptor held to that
 * module's `fstat` verdict — one decision on the inode actually opened,
 * which refuses a hard link, a foreign owner and a group- or other-readable
 * mode alike, beside the link and the FIFO (the shape a link probe cannot see
 * and an unguarded write PARKS on, with no child for the timeout to reap)
 * that the flags themselves refuse one step earlier. Nothing
 * destructive rides that open — the emptying is an `ftruncate` AFTER the
 * verdict, because `O_TRUNC` would act inside `open(2)` and empty the very
 * object the verdict then refuses.
 *
 * Refusal is therefore RECORDED rather than swallowed wherever the sink is
 * reachable, since a swallowed refusal leaves the debounce dead for every
 * later session. Where it is NOT reachable — a symlinked state root or its
 * container, refused before the directory is made — the refusal is silent,
 * because the record would have to be appended through the very component
 * being refused; that is the silence the sibling writer chooses too.
 * The guard flags DECIDE inside `open(2)` itself: a link at the leaf raises
 * `ELOOP` and a reader-less FIFO raises `ENXIO`, so for exactly the two
 * shapes the flags were added for, no descriptor ever reaches the verdict and
 * a record composed only from the verdict is composed nowhere. The open's
 * site composes the same cause/recovery pair from the ERROR — through
 * `audit.ts`'s `recoveryFor`, the vocabulary the sibling writer already
 * speaks, so one hazard keeps one spelling across both writers — and the
 * verdict's site keeps composing its own. Components ABOVE the state root are
 * not this writer's to own and are deliberately unguarded (the seam's own
 * admissible-target policy, §5.5).
 *
 * Fail direction: the advisory is observability, never enforcement
 * (§4.5 report-don't-mutate). Every failure — no git, a non-zero or killed
 * child, an unwritable stamp — degrades to SILENCE and never throws into
 * the session_start handler.
 * The TTL stamp is written only after a SUCCESSFUL compute
 * (stamp-after-success, §5.9), under `resolveStateRoot()`'s root, so a
 * failed compute retries at the next session instead of going quiet for a
 * TTL it never earned.
 */
import { spawnSync } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	appendAuditRecord,
	recoveryFor,
	sinkRefusal,
	STATE_FILE_MODE,
	STATE_PATH_GUARD_FLAGS,
	writeRecordLine,
} from "./audit.ts";
import { quoted } from "./quote.ts";

/** The TTL/debounce stamp's file name under the resolved state root (§5.9). */
export const BIND_ADVISORY_STAMP_FILE = "bind-advisory-stamp.json";

/**
 * What the borrowed sink verdict calls THIS object. The verdict is shared
 * with `audit.ts`'s appended sink; the stamp is one object rewritten whole,
 * so nothing ever appends to it and the next session is what restores it.
 */
const STAMP_NOUNS = { noun: "TTL stamp", restoredBy: "the next session recreates the stamp" } as const;

/** Advisory cadence: at most one compute per state root per hour. */
export const BIND_ADVISORY_TTL_MS = 60 * 60 * 1000;

/** Timeout bound on each child the detector spawns (§5.9). */
export const BIND_CHECK_TIMEOUT_MS = 8_000;

/**
 * Size sanity cap for the module's small reads: the stamp is one short
 * JSON object, so anything past this is not it.
 */
export const SMALL_READ_CAP_BYTES = 4_096;

/**
 * Owner-only, with the search bit the state root needs to be traversed at
 * all — the directory counterpart of `audit.ts`'s `STATE_FILE_MODE` (§5.5).
 */
const STATE_DIR_MODE = 0o700;

/**
 * The one read primitive of this module (header note): OPEN the path under
 * the guard flags, then decide on the descriptor that open returned — a
 * plain regular file inside `cap`. The decision binds the inode actually
 * opened rather than whatever the name resolves to a second time, which is
 * the same shape the stamp's writer forty lines below already takes. Throws
 * on refusal — every call site sits inside a try/catch that degrades the
 * compute to silence, which is the same outcome an unreadable path produces.
 */
function readGatedFile(path: string, cap: number): Buffer {
	const fd = openSync(path, constants.O_RDONLY | STATE_PATH_GUARD_FLAGS);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > cap) {
			throw new Error("gitjig: refused a session-start read path that is not a plain regular file inside its cap");
		}
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** The exact re-arm command every degraded-state advisory names (§5.2). */
export const BIND_REARM_COMMAND = "bash .githooks/bind_local_tier.sh";

/** The session-entry type the advisory rides (the harness-readable surface). */
export const BIND_ADVISORY_ENTRY_TYPE = "gitjig-bind-advisory";

/**
 * States that surface one advisory each (§5.2): no hooks path configured
 * at all, and one that does not resolve to this repository's committed
 * adapters — classified degraded rather than argued with, since this
 * repository's hooks do not fire under it whoever chose it.
 */
const DEGRADED_STATES = ["unbound", "foreign-bound"] as const;

/** The one state that stays silent: the effective value is the committed adapters (§5.2). */
const SILENT_STATES = ["bound"] as const;

export type BindState = (typeof DEGRADED_STATES)[number] | (typeof SILENT_STATES)[number];

/**
 * The line one degraded state earns: the state token and the exact re-arm
 * command (§5.2), and no clause asserting a consequence. A single token
 * covers several on-disk shapes, and a consequence stated for the token is
 * true of some of them and false of others — an operator who checks one and
 * finds it false retires the surface (§3.11's dead-recovery rule).
 */
function degradedMessage(state: BindState): string {
	return `gitjig bind state: ${state}; run \`${BIND_REARM_COMMAND}\` from the repository root`;
}

/**
 * The one surface a refused stamp write takes (§5.2). A refused stamp is not
 * a refused advisory, but it IS a permanently dead debounce: the stamp stays
 * unwritten, the next session's read refuses it again, and the TTL never
 * engages. §5.2 forbids a silently degraded state, so the refusal takes the
 * surface the rest of this tier already uses for degradation — ONE audit
 * record per refused write, carrying the cause and the recovery live for the
 * shape that refused. The record degrades open like every other append, so
 * the advisory stays observability and this path can still not fail the
 * session (§4.5, §5.9).
 */
function recordStampRefusal(stateRoot: string, cause: string, recovery: string): void {
	appendAuditRecord(stateRoot, {
		category: "runtime",
		action: "bind-advisory-stamp-refused",
		text:
			`the bind advisory's TTL stamp could not be written, so the once-per-hour debounce is not in ` +
			`effect and this compute repeats every session. Cause: ${cause}. Recovery: ${recovery}`,
	});
}

/**
 * Constructed child environment (#39): never the inherited env wholesale.
 * This child's environment is exactly the literal below — PATH, HOME,
 * GIT_TERMINAL_PROMPT, GIT_NO_REPLACE_OBJECTS, LC_ALL — plus
 * XDG_CONFIG_HOME and GIT_CONFIG_NOSYSTEM when the session sets them. HOME
 * and XDG_CONFIG_HOME are the two that make the classifier read the same
 * config FILES the consumer reads, which is why they are on it.
 *
 * That set is the whole of what this child gets, so anything else the
 * session carries is live for the consumer's git and absent for this one,
 * and the two answers can diverge in either direction — over configuration
 * and over repository identity alike. One measured instance of each, on a
 * locally bound clone: with GIT_CONFIG_COUNT=1,
 * GIT_CONFIG_KEY_0=core.hooksPath and GIT_CONFIG_VALUE_0=/nonexistent-hooks
 * in the session env, the consumer's git resolves /nonexistent-hooks and
 * commits under no hook while this child resolves .githooks; with GIT_DIR
 * and GIT_WORK_TREE naming an unbound sibling clone, the consumer's git
 * resolves an empty hooksPath and a toplevel at the sibling while this
 * child answers about the clone the session stands in. Both read `bound`,
 * the silent state.
 */
function childEnv(): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		LC_ALL: "C",
	};
	if (process.env.XDG_CONFIG_HOME !== undefined) {
		env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
	}
	if (process.env.GIT_CONFIG_NOSYSTEM !== undefined) {
		env.GIT_CONFIG_NOSYSTEM = process.env.GIT_CONFIG_NOSYSTEM;
	}
	return env;
}

/**
 * One `git` child's outcome, discriminated: git separates a key it does not
 * carry from one it carries as the empty string by the read's EXIT STATUS,
 * and a single string return collapses the two. They are different clones —
 * under an empty value git resolves an empty hooks path and fires nothing,
 * while an absent key is a clone that was never armed — so the distinction
 * git draws is carried rather than discarded.
 */
type GitAnswer = { kind: "failed" } | { kind: "absent" } | { kind: "value"; value: string };

/**
 * One timeout-bounded, constructed-environment `git` child.
 *
 * The value is git's own output with exactly ONE trailing newline removed —
 * git's terminator, and nothing beyond it. A `trim()` here would discard the
 * bytes of the very value being classified: git stores and resolves a
 * `core.hooksPath` ending in a newline, no hook fires under it, and a trimmed
 * read compares a path git never resolved and answers `bound`, the silent
 * state.
 */
function gitAnswer(cwd: string, args: string[], absentStatus?: number): GitAnswer {
	const result = spawnSync("git", args, {
		cwd,
		env: childEnv(),
		timeout: BIND_CHECK_TIMEOUT_MS,
		killSignal: "SIGKILL",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.error !== undefined || result.signal !== null) {
		return { kind: "failed" };
	}
	if (result.status !== 0) {
		return result.status === absentStatus ? { kind: "absent" } : { kind: "failed" };
	}
	const out = (result.stdout ?? Buffer.alloc(0)).toString("utf8");
	return { kind: "value", value: out.endsWith("\n") ? out.slice(0, -1) : out };
}

/**
 * Classify the clone the session stands in from the configuration git
 * resolves. `undefined` means "could not compute" — not a git repository,
 * or a child that failed or was killed — and the caller must treat it as
 * silence WITHOUT a stamp.
 *
 * The hooks path is read MERGED (`--path --get`, every scope), because what
 * fires is what git resolves; a classifier answering about a narrower
 * scope would describe a repository nobody is running (§4.7's scope split).
 * `git config --get` exits 1 on an unset key, which is the `unbound` state
 * and not a failed child. A key the clone DOES carry, as the empty string,
 * exits 0 instead, and git fires no hook under it: that is a degraded clone
 * carrying a setting, not an unarmed one, so it classifies `foreign-bound`.
 * Both sides of the comparison are resolved physically, so an equivalent
 * spelling of the committed adapters is `bound` and a path-prefix collision
 * cannot mis-answer in either direction (§4.6). An unresolvable side is not
 * this repository's committed adapters, which is exactly what
 * `foreign-bound` says.
 *
 * `bound` is the SILENT state, so it is only reached where the adapters
 * would actually run: the resolved directory must lie under the resolved
 * top — both sides are realpath-ed before the compare, never the caller's
 * own cwd, which the caller supplies unresolved — and each of the three
 * adapters git executes must be a regular, non-empty file this account can
 * execute. Those three questions are what arming rests on: git skips a hook
 * file that is not executable, and runs an empty one as a no-op, so neither
 * arms anything while both pass a presence probe. They are asked of the
 * filesystem alone; this classifier runs no program of the repository it
 * classifies, so it asks whether an adapter could run and never what it
 * decides — an executable, non-empty adapter whose body decides nothing is
 * `bound` here, and provenance is not asked at all.
 */
const COMMITTED_ADAPTERS = ["pre-commit", "pre-push", "commit-msg"] as const;

export function computeBindState(cwd: string): BindState | undefined {
	const topAnswer = gitAnswer(cwd, ["rev-parse", "--show-toplevel"]);
	if (topAnswer.kind !== "value" || topAnswer.value === "") {
		return undefined;
	}
	const top = topAnswer.value;
	// `--path` reads the value as git resolves it: a `~/`-spelled hooks path
	// is expanded to the absolute path git honours, and a relative spelling is
	// left as it is. Without it the join below turns `~/x` into `<top>/~/x`
	// and an equivalent spelling of this clone's own adapters classifies
	// `foreign-bound` — a degraded advisory every TTL window on a clone whose
	// tier fires (§4.7's equivalent-spelling rule).
	const answer = gitAnswer(cwd, ["config", "--path", "--get", "core.hooksPath"], 1);
	if (answer.kind === "failed") {
		return undefined;
	}
	if (answer.kind === "absent") {
		return "unbound";
	}
	const configured = answer.value;
	if (configured === "") {
		return "foreign-bound";
	}
	try {
		const physicalTop = realpathSync(top);
		const want = realpathSync(join(top, ".githooks"));
		const have = realpathSync(isAbsolute(configured) ? configured : join(top, configured));
		if (have !== want) {
			return "foreign-bound";
		}
		if (have !== physicalTop && !have.startsWith(physicalTop.endsWith(sep) ? physicalTop : physicalTop + sep)) {
			return "foreign-bound";
		}
		for (const adapter of COMMITTED_ADAPTERS) {
			const adapterPath = join(have, adapter);
			const adapterStat = statSync(adapterPath);
			if (!adapterStat.isFile() || adapterStat.size === 0) {
				return "foreign-bound";
			}
			accessSync(adapterPath, constants.X_OK);
		}
		return "bound";
	} catch {
		return "foreign-bound";
	}
}

/**
 * True iff the stamp at `stampPath` is readable, well-formed and inside
 * the TTL. The read rides the module's gate (header note): this one runs
 * BEFORE the compute, so an ungated read here parks session start on a
 * planted FIFO without even a child to reap. A refusal is "no fresh
 * stamp", so the session goes on to compute and advise.
 */
function stampIsFresh(stampPath: string): boolean {
	try {
		const at = (JSON.parse(readGatedFile(stampPath, SMALL_READ_CAP_BYTES).toString("utf8")) as { at?: unknown }).at;
		return typeof at === "number" && Number.isFinite(at) && Math.abs(Date.now() - at) < BIND_ADVISORY_TTL_MS;
	} catch {
		return false;
	}
}

/**
 * The session_start entry point: debounced by the TTL stamp, silent on
 * bound, one advisory entry per degraded state naming the
 * state token and the exact re-arm command. Never throws, never blocks
 * beyond the child timeout bound.
 */
export function maybeAdviseBindState(pi: Pick<ExtensionAPI, "appendEntry">, stateRoot: string): void {
	try {
		const stampPath = join(stateRoot, BIND_ADVISORY_STAMP_FILE);
		if (stampIsFresh(stampPath)) {
			return;
		}
		const state = computeBindState(process.cwd());
		if (state === undefined) {
			// Degraded compute: silence, and NO stamp — retry next session (§5.9).
			return;
		}
		if ((DEGRADED_STATES as readonly string[]).includes(state)) {
			pi.appendEntry(BIND_ADVISORY_ENTRY_TYPE, {
				state,
				rearm: BIND_REARM_COMMAND,
				message: degradedMessage(state),
			});
		}
		// Stamp-after-success: only a compute that answered earns the TTL.
		//
		// A symlink at a DIRECTORY component this write would create or
		// traverse is another writer's target: the state root's container and
		// the state root itself are lstat-ed — the link itself, never its
		// target — because `mkdirSync(…, {recursive: true})` follows both. An
		// absent component is not a refusal: it is the ordinary first write.
		// The stamp LEAF carries no such probe: the open below refuses a link
		// at that component itself, on the descriptor it returns, which is the
		// same refusal without the window an lstat-then-write pair leaves open.
		for (const component of [dirname(stateRoot), stateRoot]) {
			try {
				if (lstatSync(component).isSymbolicLink()) {
					return;
				}
			} catch {
				// Absent — nothing to refuse; the create below proceeds.
			}
		}
		// §5.5 at creation: this advisory is the FIRST writer to materialize
		// the state root on a clone that has never recorded anything, so the
		// modes minted here are the modes the shell's namespace keeps — no
		// later run tightens them. A mode passed at creation is a CEILING
		// under the ambient umask (a umask only removes bits), which is the
		// direction §5.5 binds: state at rest is readable only by the account
		// that writes it.
		mkdirSync(stateRoot, { recursive: true, mode: STATE_DIR_MODE });
		// The stamp is opened, not written by name (`audit.ts`'s sink shape,
		// shared through its exported guard flags): `O_NOFOLLOW` refuses a
		// link planted at the leaf, `O_NONBLOCK` turns an open on a
		// reader-less FIFO into an immediate `ENXIO` instead of a session-start
		// park that no child timeout reaches, and the `fstat` verdict binds to
		// the inode actually opened — a regular file, one name, owner-only,
		// this account's. The first two act inside `open(2)`, so their
		// refusals arrive as ERRORS the verdict never sees: both sites record,
		// on the same surface, in the same shape.
		//
		// The open carries NO `O_TRUNC`, and the emptying is a separate
		// `ftruncate` after the verdict, because `O_TRUNC` acts inside
		// `open(2)`: with it on the flags, a hard-linked or loose-mode stamp is
		// emptied and only THEN refused, so the refusal the verdict exists to
		// deliver arrives after the damage — a victim file reaches 0 bytes with
		// nothing ever written, which the hard-linked-stamp arm in
		// `test/bind-advisory.integration.test.ts` measures on real bytes.
		// `audit.ts`'s own sink never had the hazard —
		// it opens `O_APPEND` — so the borrowed verdict's contract ("opened and
		// refused before the write") holds here only once the truncation moves
		// behind it. The stamp is still one object rewritten whole rather than a
		// trail, which is what the `ftruncate` preserves.
		let fd: number;
		try {
			fd = openSync(
				stampPath,
				constants.O_WRONLY | constants.O_CREAT | STATE_PATH_GUARD_FLAGS,
				STATE_FILE_MODE,
			);
		} catch (error) {
			// The guard flags refuse INSIDE `open(2)`: `ELOOP` for a link at the
			// leaf, `ENXIO` for a reader-less FIFO. Those are the two shapes the
			// flags exist for, and for them no descriptor ever reaches the verdict
			// below — so a refusal recorded only there is recorded NOWHERE, and the
			// debounce dies with nothing on any surface, which is the consequence
			// the record was added to remove. The consequence is identical to the
			// verdict's, so the record is: the cause is the open's own error,
			// escaped at the extraction (#47 — a filesystem message embeds the path
			// verbatim), and the recovery is `audit.ts`'s `recoveryFor`, which
			// routes each code to the object that actually failed instead of
			// prescribing one act that is dead for most of them.
			recordStampRefusal(
				stateRoot,
				`the stamp at ${quoted(stampPath)} could not be opened: ` +
					`${quoted(error instanceof Error ? error.message : String(error))}`,
				recoveryFor(error, stateRoot, stampPath),
			);
			return;
		}
		try {
			const refusal = sinkRefusal(fstatSync(fd), stampPath, STAMP_NOUNS);
			if (refusal === undefined) {
				ftruncateSync(fd, 0);
				writeRecordLine(fd, `${JSON.stringify({ at: Date.now(), state })}\n`);
			} else {
				// The verdict's own composed cause and its arm-scoped recovery (a
				// stamp pre-created 0644 is the honest-mistake shape, and
				// `sinkRefusal` names the live `chmod 600` for exactly it).
				recordStampRefusal(stateRoot, refusal.cause, refusal.recovery);
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		// §4.5/§5.9: the advisory may never abort or block a session.
	}
}
