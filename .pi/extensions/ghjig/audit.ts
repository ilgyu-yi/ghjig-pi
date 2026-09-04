/**
 * Audit primitive — one record per line (SPEC §5.5).
 *
 * Each record is a single JSON object on its own line in
 * `<stateRoot>/audit.jsonl`. Free text passes through `JSON.stringify`
 * at write time, so embedded newlines and control characters can never
 * split a record.
 *
 * The sink is opened rather than appended to by name, on two counts §4.6
 * and §5.5 make binding:
 *
 *   - `O_NOFOLLOW` — the evidence comes to rest at the path the gate
 *     reads, and in the file that path names (§4.6). What a symlink
 *     planted at the sink path buys its planter is not a write/read
 *     divergence: a consumer reading the sink BY NAME follows the same
 *     link to the same bytes, so both sides do agree. What it buys is
 *     the record itself — every line lands in a file the planter chose
 *     and can read, and can rewrite before any consumer reads it. The
 *     open refuses the link instead of following it, and the refusal
 *     degrades open like any other unwritable destination.
 *   - mode `0600` — the record at rest is readable only by the account
 *     that writes it (§5.5). Passed on the create, which makes `0600` a
 *     CEILING rather than a mode independent of the ambient umask: a
 *     umask only removes bits, so the sink is never looser than `0600`
 *     and may be tighter (measured: `umask 077` and `umask 022` both
 *     land `600`; `umask 777` lands `000`, which the next append then
 *     degrades open on). The direction that matters for §5.5 is the one
 *     the ceiling binds. The sink is a file only this runtime writes, so
 *     no legitimate flow is refused (§3.6 obligation (i)).
 *
 * Fail posture (§3.9, `audit-append` row): a missing or unwritable
 * destination degrades OPEN — warn, return `false`, never throw. The
 * warning names the consequence in plain words, because §3.9 requires a
 * gate that fails open to say it is not enforced rather than leave a
 * reader to infer it; the returned boolean is what lets a caller record
 * that outcome on a durable surface. This primitive also never creates
 * the destination directory: state-root creation belongs to the first
 * operational writer, not to observability (§3.8 — additive
 * observability never moves a fail direction).
 *
 * `stateRoot` must be ABSOLUTE, and a root that is not is refused the
 * same way any other unusable destination is — warn, return `false`,
 * never throw. A relative or empty root is resolved against the process
 * working directory, which §4.6 keeps off the hot path, and would put
 * the trail wherever the process happens to stand rather than inside
 * the repository whose work it records (§5.5). `resolveStateRoot`
 * already refuses an empty or relative seam, so nothing shipped reaches
 * this arm; it is here because the mirror-image precondition on
 * `locateRepoRootFrom` was closed on exactly this reasoning, and a sink
 * that writes evidence to an ambient location is the harsher half of
 * the pair. It refuses by degrading rather than by throwing, as
 * `locateRepoRootFrom` does, because the `audit-append` row is open
 * where `repo-root-discovery` is not.
 *
 * Neither flag closes every hostile shape at the sink path, so the open
 * is followed by one `fstat` VERDICT on the descriptor it returned —
 * no TOCTOU window, the verdict binds to the opened inode (#44). It
 * refuses anything that is not a regular file carrying exactly one name,
 * no group/other mode bits, and this account's ownership; every refusal
 * degrades open like any other unwritable destination. The hard link is
 * why `nlink === 1` is demanded: the link IS a regular file this account
 * can append to, so `O_NOFOLLOW` admits it and every record would land
 * in an inode another name owns and can read. A FIFO is why `O_NONBLOCK`
 * rides `SINK_FLAGS`: `openSync` on a reader-less FIFO otherwise blocks
 * before any verdict can run, hanging the extension factory that appends
 * at load. With the flag, the reader-less open raises `ENXIO` at once
 * and an open with a reader returns a descriptor the verdict refuses —
 * both branches terminate, so §5.9's hung-dependency requirement is met
 * by this narrower fix and NO timeout wrapper sits at factory scope: a
 * timeout converts a refusal that carries its cause into one that
 * carries none. The flag is never cleared — Node exposes no `fcntl` to
 * clear it, and clearing is unnecessary because only a regular file
 * survives the verdict and POSIX gives `O_NONBLOCK` no effect on
 * regular-file `write(2)`. What stays open (§3.11): a symlinked ANCESTOR
 * of the sink path is still followed — the admissible-target policy for
 * ancestors belongs to the state-root seam (§5.5) and is not closed
 * here.
 *
 * The record is written through `writeRecordLine` — the fd form of
 * `writeFileSync`, never `writeSync`. `writeSync` is one `write(2)`: it
 * returns a byte COUNT, and a count smaller than the payload leaves the
 * caller holding a partial record it believes is the whole one, so the
 * append returns `true` and a durable registration entry folds a clean
 * `auditWritable`. What the fd form removes is that FALSE SUCCESS: it
 * loops until the buffer drains and raises the underlying error when it
 * cannot, so a record that did not land whole is reported as a failure.
 * That is the same false success the close handling below exists to
 * remove, on the write side.
 *
 * It does NOT make the append transactional: "the record was written"
 * and "the append degraded" are not exclusive at the file level, and the
 * reported failure is about the caller's belief, not about the bytes at
 * the destination. A failure part-way through the loop
 * leaves an unterminated prefix at the sink AND takes the degradation
 * path; the next append concatenates onto that prefix, so the sink
 * carries one malformed line. That torn record is the one way the
 * one-record-per-line format above can break — free text never breaks
 * it — and it is the residual this primitive does not model (§3.11).
 * Through `appendAuditRecord` the descriptor carries `O_NONBLOCK`, but
 * only a regular file survives the verdict and `O_NONBLOCK` has no
 * effect on regular-file `write(2)` (POSIX), so the
 * reachable instance is a mid-write `ENOSPC` on a regular file, and no
 * act on the writer side repairs a line already at rest: the consumer of
 * the trail is the side that must refuse a final line carrying no
 * newline rather than parse it — a lossy fallback refuses what it cannot
 * process rather than answering a different, weaker question (§3.10).
 *
 * The write-all property is pinned at the SEAM rather than through this
 * function (§3.12). A short write is not stageable through
 * `appendAuditRecord` — only a regular file reaches the write, where the
 * non-blocking flag is inert, so staging one would need a filesystem
 * filled mid-write on a test host — but "cannot return without writing
 * everything, or raise" is a property of `writeRecordLine` alone, and a
 * non-blocking descriptor ON A PIPE stages it in one call. That is why
 * the write is a named export rather than an inline call, the same
 * device the recovery arms use to reach `recoveryFor` directly and the
 * sink verdict uses for its root-only dimensions.
 *
 * "Never throw" reaches the close. `closeSync` reports delayed-write
 * failures (`EIO`, `ENOSPC`, a network filesystem), and a throw out of a
 * `finally` REPLACES the return the block was already carrying — the
 * `return false` this posture owes its caller included — escaping into
 * the extension factory that calls the load-marker site and aborting
 * extension load, the fail-closed outcome the `audit-append` row denies.
 * So the success path closes INSIDE the guarded region, where a failed
 * close degrades open like any other write failure, and the `finally`
 * closes only the descriptor a failed write left behind, guarded because
 * a second failure on an already-reported append has nothing to add.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { quoted } from "./quote.ts";

/** The audit file name the runtime and its consumers agree on (§5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

/**
 * The two flags that make an open at a shell-state path DECIDE rather than
 * follow or block: never through a symlink (§4.6), and never parked on a
 * reader-less FIFO (see the header; both are inert on the regular files
 * that survive the verdict below).
 *
 * Exported because this sink is not the only file the runtime opens inside
 * the shell's own namespace: the bind advisory's TTL stamp
 * (`bind-state.ts`) opens with the same pair and holds its descriptor to
 * the same `sinkRefusal` verdict, and that module's own read of the stamp
 * carries them too. The hazard is one hazard, so it has one spelling — a
 * second copy is a second thing to forget.
 */
export const STATE_PATH_GUARD_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Owner read/write only — any shell state file at rest (§5.5). */
export const STATE_FILE_MODE = 0o600;

/** Append-only, create-if-absent, and guarded as above. */
const SINK_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | STATE_PATH_GUARD_FLAGS;

/**
 * Writes `line` to an open descriptor and returns only when every byte of
 * it has landed; otherwise it raises. The fd form of `writeFileSync` loops
 * over partial writes, where `writeSync` is one `write(2)` that reports a
 * short count as a success (see the header).
 *
 * Exported for two reasons now. It has a PRODUCTION caller outside this
 * module: the bind advisory's TTL stamp (`bind-state.ts`) writes its one
 * object through this function, on a descriptor it opened under the same
 * guard flags — the write-all property is one property, so it has one
 * spelling. And the property is measured through this export where it is
 * stageable (§3.12): the descriptor `appendAuditRecord` hands this function
 * has survived the sink verdict, so it is a regular file — where its
 * `O_NONBLOCK` is inert — and a short write cannot be provoked through that
 * surface, while on a non-blocking PIPE descriptor it is one call away.
 */
export function writeRecordLine(fd: number, line: string): void {
	writeFileSync(fd, line);
}

/** A sink-verdict refusal: what was measured, and the act that repairs it. */
export interface SinkRefusal {
	cause: string;
	recovery: string;
}

/**
 * How the caller's object names itself in the two operator-facing clauses.
 * The verdict is shared by two objects with different lives — this module's
 * appended sink and the bind advisory's rewritten TTL stamp — and a clause
 * that calls the stamp a sink, or tells the operator an append will restore
 * a file nothing ever appends to, describes an object that is not there.
 *
 * Both fields are CLOSED literal unions rather than free strings: they are
 * interpolated into the two clauses without escaping, and a closed set of
 * spellings enumerated here is what makes "this expression carries no path"
 * a fact a reader can check rather than a habit a caller can break (§3.10,
 * issue #47).
 */
export interface GuardedObjectNouns {
	/** The object as the cause names it. */
	noun: "sink" | "TTL stamp";
	/** What restores it once the path is clear, as the recovery names it. */
	restoredBy: "the append recreates the sink" | "the next session recreates the stamp";
}

const SINK_NOUNS: GuardedObjectNouns = {
	noun: "sink",
	restoredBy: "the append recreates the sink",
};

/**
 * The verdict the open's `fstat` answer is held to (§4.6, §5.5 — see the
 * header). Admits exactly a regular file carrying one name, no
 * group/other mode bits, and this account's ownership; anything else is
 * a refusal the caller degrades open on, never a throw. Every failing
 * dimension is enumerated in the cause rather than the first alone —
 * partly for the operator, and partly because it is what lets one real
 * kernel object pin several dimensions at once at the seam (§3.12): the
 * owner and character-device dimensions are not stageable AT THE SINK
 * PATH without root (chown to another account and mknod both need root,
 * and `link(2)` from devfs is cross-device), so they are measured
 * against real `fstat` Stats of `/dev/null`, through this export — the
 * same device `writeRecordLine` and `recoveryFor` already are. The export
 * also has a PRODUCTION caller outside this module: the bind advisory's
 * TTL stamp (`bind-state.ts`) holds its own opened descriptor to this
 * verdict, and surfaces the refusal it returns — cause and recovery both —
 * as one audit record. The hazard is one hazard, so it has one spelling.
 *
 * The recovery is arm-scoped (§3.11): the type/link/owner shapes are
 * hostile-input class and get the terse general act (make the path a
 * fresh plain file), while a loose mode alone is honest-mistake
 * reachable — a sink pre-created `0644` keeps its bits, since the
 * `0600` create mode binds only at creation — and names the one live
 * act, `chmod 600`. Naming `chmod` while the type or owner dimension
 * also fails would prescribe a dead act, so it is named only when the
 * mode is all that failed.
 *
 * Both recovery clauses are COMMAND context — text the clause invites
 * the operator to paste — so the path rides the `"shell"` delimiter of
 * `quoted`, POSIX single quotes inside which a substitution-shaped
 * component is bytes rather than an execution (issue #53). The cause
 * keeps the JSON delimiter: it is read, never pasted, and the suite's
 * clause reader decodes exactly that production. The §3.11 division
 * stands unchanged — the cause stays content-free about the act, the
 * recovery names the act and the path it lands on.
 *
 * Where `process.geteuid` is absent (win32), the owner dimension is
 * unmeasurable in these terms and is SKIPPED rather than refused —
 * enumerated residual (§3.11): POSIX ownership does not model that
 * host's ACLs, and refusing every append there would move the row's
 * fail direction on a dimension no act on that host repairs.
 */
export function sinkRefusal(
	stats: Stats,
	sinkPath: string,
	nouns: GuardedObjectNouns = SINK_NOUNS,
): SinkRefusal | undefined {
	const failed: string[] = [];
	if (!stats.isFile()) {
		failed.push("it is not a regular file");
	}
	if (stats.nlink !== 1) {
		failed.push(`its inode carries ${stats.nlink} names, not one`);
	}
	const modeFailed = (stats.mode & 0o077) !== 0;
	if (modeFailed) {
		failed.push(`its mode ${(stats.mode & 0o777).toString(8)} admits group or other accounts`);
	}
	const euid = process.geteuid?.();
	if (euid !== undefined && stats.uid !== euid) {
		failed.push(`it is owned by uid ${stats.uid}, not this account (euid ${euid})`);
	}
	if (failed.length === 0) {
		return undefined;
	}
	return {
		cause: `the ${nouns.noun} at ${quoted(sinkPath)} was opened and refused before the write: ${failed.join("; ")}`,
		recovery:
			modeFailed && failed.length === 1
				? `run \`chmod 600 ${quoted(sinkPath, "shell")}\`, then re-run — shell state at rest is readable only by the account that writes it (§5.5).`
				: `remove ${quoted(sinkPath, "shell")}, then re-run — ${nouns.restoredBy} as a plain 0600 file carrying exactly one name.`,
	};
}

/**
 * The deepest existing ancestor of `sinkPath` that is not a directory —
 * the component an `ENOTDIR` open reports on, and the only object at
 * which that failure has a live fix. Walks upward from the sink's own
 * directory and stops at the first component that answers: a directory
 * means every component above it is one too, so nothing higher can be
 * the offender. Every probe answers rather than throws, for the reason
 * the whole primitive does — this runs on the degradation path, and a
 * throw here would replace the warning it exists to compose.
 */
function nonDirectoryAncestor(sinkPath: string): string | undefined {
	let current = dirname(sinkPath);
	for (;;) {
		const kind = componentKind(current);
		if (kind !== "absent") {
			return kind === "directory" ? undefined : current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/** One path component, probed without throwing. */
function componentKind(path: string): "directory" | "other" | "absent" {
	try {
		return statSync(path).isDirectory() ? "directory" : "other";
	} catch {
		// A dangling link is present and is not a directory: it is an
		// offender, not an absent component to walk past.
		try {
			lstatSync(path);
			return "other";
		} catch {
			return "absent";
		}
	}
}

/**
 * The recovery live at THIS surface for the failure that actually
 * occurred (§3.11 — arm-scoped remediation; a message naming a dead
 * recovery is worse than one naming none). Each arm names a different
 * object as the one to repair:
 *
 *   - the destination directory is absent — create it;
 *   - an ancestor of it is a plain file (`ENOTDIR`) — nothing can be
 *     created beneath a file, so the fix is at that component, never at
 *     the sink path the append named;
 *   - the destination directory refuses the create (`EACCES` with no
 *     sink measurable there) — the sink cannot be made anything at all,
 *     so the fix is the directory's mode;
 *   - the filesystem has no room for the record (`ENOSPC`, `EDQUOT`) —
 *     the object is that filesystem's free space or this account's
 *     quota, and nothing at the sink path is misconfigured;
 *   - the mount refuses writes (`EROFS`) — the object is the mount; no
 *     mode at the sink path admits the record while it holds;
 *   - the device or transport failed (`EIO`) — no act at the sink path
 *     recovers a record the filesystem has already refused, so the
 *     message names the filesystem's health and stops there rather than
 *     prescribing a repair that would not have helped;
 *   - the sink path itself is unusable — make it a plain, owner-writable
 *     file. This is the general arm, and the arms above exist so that it
 *     is reached only where the sink really is the object that failed
 *     (a directory, a symlink, another account's file).
 *
 * The last three arms are the DELAYED-WRITE class the fail posture above
 * routes here: `closeSync` reports a write the filesystem accepted and
 * then refused, so those codes arrive at this function by that path as
 * well as from the open. They are arms rather than enumerated residuals
 * because each has an act an operator can perform, and the general arm's
 * act — make the path a plain writable file — is dead for all of them:
 * it is already one.
 *
 * The arms above are the modelled objects; every other code reaches the
 * general arm carrying its message. What decides whether that message is
 * honest is a RULE, stated here rather than a roster of the shapes it
 * generates, because the roster is what a later code silently falsifies
 * (§2.4, §3.11): the general arm's act — make the path a plain,
 * owner-writable file — is live exactly when the sink path is the object
 * that failed. Every unmodelled failure whose object lies elsewhere
 * carries a dead act, and what it delivers is the cause alone; the append
 * still degrades open, with no repair named that would have helped. Such
 * a shape earns an arm when it acquires an act an operator can perform at
 * a named object, and not before.
 *
 * Exported for the arms that measure the routing directly. A shape whose
 * failure no honest check can stage on a test host — no filesystem is
 * filled, no mount is remounted, no device is broken (§3.12) — is still
 * owed a pin on which recovery it selects, and that pin is a call.
 */
export function recoveryFor(error: unknown, stateRoot: string, sinkPath: string): string {
	const code = (error as { code?: string } | null)?.code;
	if (code === "ENOENT") {
		return `create the state directory ${quoted(stateRoot)} (mkdir -p), then re-run.`;
	}
	if (code === "ENOTDIR") {
		return (
			`replace ${quoted(nonDirectoryAncestor(sinkPath) ?? stateRoot)} with a directory — it is not one, ` +
			`and nothing can be created beneath a plain file — then create ${quoted(stateRoot)} (mkdir -p) and re-run.`
		);
	}
	// The guard is what keeps this arm's own recovery live: it prescribes an
	// act on the destination directory, so it fires only when that directory
	// is there to be acted on. EACCES raised because some ancestor is
	// unsearchable — where the destination itself cannot even be measured —
	// is a different object and is left to the general arm below. The sink
	// probe reads as "not measurable as present", not as "absent": a
	// destination whose own mode refuses the stat answers false here with a
	// sink sitting inside it, and that is still this arm's object, so the
	// message must not assert an absence it did not establish.
	if (code === "EACCES" && !existsSync(sinkPath) && componentKind(stateRoot) === "directory") {
		return (
			`grant this account write and search permission on the state directory ` +
			`${quoted(stateRoot)} (chmod u+wx), then re-run — until its mode admits this account the file there ` +
			`can be neither opened nor created, and cannot even be measured to say which.`
		);
	}
	if (code === "ENOSPC" || code === "EDQUOT") {
		return (
			`free space on the filesystem holding ${quoted(sinkPath)}, or raise this account's quota on it, ` +
			`then re-run — the write was refused for want of room, not for want of permission, ` +
			`so nothing at that path is misconfigured and no mode there admits it.`
		);
	}
	if (code === "EROFS") {
		return (
			`remount the filesystem holding ${quoted(sinkPath)} read-write, or point the state root at a ` +
			`writable filesystem, then re-run — while the mount refuses writes no permission or mode ` +
			`at that path can admit the write.`
		);
	}
	if (code === "EIO") {
		return (
			`no act at ${quoted(sinkPath)} restores this write: it reached the filesystem and the device or ` +
			`transport under it reported an error, so what was being written is lost. Restore the health ` +
			`of that filesystem — for a network mount, its connection — then re-run.`
		);
	}
	return (
		`make ${quoted(sinkPath)} a plain file writable by this account, then re-run — ` +
		`a directory, a FIFO, a symlink, or another account's file at that path all refuse the write ` +
		`(a symlink at that final component is refused rather than followed, and a reader-less FIFO raises ENXIO at ` +
		`the open; a symlink at a PARENT is still followed — that ancestor policy belongs to the state-root seam (§5.5)).`
	);
}

/**
 * The one degradation signal this primitive emits (§3.9, §3.11). Both
 * the precondition refusal and the failed append reach the operator in
 * the same shape — consequence in plain words, then cause, then the act
 * that restores the trail — because a reader who has learned to read one
 * of them has learned to read the other.
 */
function warnDegraded(cause: string, recovery: string): void {
	console.warn(
		`[ghjig] audit append failed: no audit evidence is being recorded for this run — ` +
			`the audit trail is NOT ENFORCED. Degrading open rather than blocking (§3.9). ` +
			`Cause: ${cause}. ` +
			`Recovery: ${recovery}`,
	);
}

export interface AuditInput {
	category: string;
	action: string;
	/** Free text; encoded at write time, round-trips intact. */
	text: string;
}

export function appendAuditRecord(stateRoot: string, input: AuditInput): boolean {
	// Before anything is opened: a root that is not absolute has no anchor
	// but the process working directory, and resolving against it would
	// write the trail outside the repository the trail is about — and
	// report success (§4.6, §5.5). The refusal is a degradation, not a
	// throw, because this row is open (see the header).
	if (!isAbsolute(stateRoot)) {
		warnDegraded(
			`the state root ${quoted(stateRoot)} is not an absolute path, so the sink under it would ` +
				`resolve against whatever directory this process happens to stand in`,
			`call this primitive with the absolute state root \`resolveStateRoot\` returns — the trail belongs ` +
				`inside the repository whose work it records, and an ambient working directory is not one.`,
		);
		return false;
	}
	const record = {
		timestamp: new Date().toISOString(),
		category: input.category,
		action: input.action,
		text: input.text,
	};
	const sinkPath = join(stateRoot, AUDIT_FILE_NAME);
	// Holds the descriptor only while a failure could still leak it: cleared
	// before the success-path close so the `finally` never closes it twice.
	let leaked: number | undefined;
	try {
		const fd = openSync(sinkPath, SINK_FLAGS, STATE_FILE_MODE);
		leaked = fd;
		// The verdict binds to the opened inode BEFORE any byte is written
		// (see the header): a refusal degrades open through the same signal
		// every other unwritable destination takes, and the `finally` below
		// closes the descriptor it leaves behind.
		const refusal = sinkRefusal(fstatSync(fd), sinkPath);
		if (refusal !== undefined) {
			warnDegraded(refusal.cause, refusal.recovery);
			return false;
		}
		// Write-all, not one `write(2)`: a short count discarded here is a
		// partial record reported as a success (see the header).
		writeRecordLine(fd, `${JSON.stringify(record)}\n`);
		leaked = undefined;
		closeSync(fd);
		return true;
	} catch (error) {
		// Escaped at the extraction (issue #47): a filesystem error message
		// embeds the sink path verbatim, so this carrier forges lines exactly
		// as an interpolation does.
		const reason = quoted(error instanceof Error ? error.message : String(error));
		warnDegraded(reason, recoveryFor(error, stateRoot, sinkPath));
		return false;
	} finally {
		if (leaked !== undefined) {
			try {
				closeSync(leaked);
			} catch {
				// The append already failed and the warning above carries its
				// cause; a close failure stacked on it adds nothing a reader can
				// act on, and letting it out of the `finally` would replace the
				// `return false` this posture owes its caller.
			}
		}
	}
}
