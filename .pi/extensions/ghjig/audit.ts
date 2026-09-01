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
 * One shape defeats the open posture and is NOT closed here: a FIFO at
 * the sink path. `O_NOFOLLOW` refuses a symlink, not a named pipe, and
 * `openSync` on a FIFO with no reader blocks indefinitely — the append
 * neither returns nor throws, so the extension factory hangs where this
 * row promises a warning and a `false`. Measured identical before and
 * after this primitive stopped using `appendFileSync`, so it is neither
 * introduced nor widened here. Enumerated in place rather than left to
 * the ticket alone (§3.11); tracked as #44.
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
 * Through `appendAuditRecord` the descriptor is always blocking, so the
 * reachable instance is a mid-write `ENOSPC` on a regular file, and no
 * act on the writer side repairs a line already at rest: the consumer of
 * the trail is the side that must refuse a final line carrying no
 * newline rather than parse it — a lossy fallback refuses what it cannot
 * process rather than answering a different, weaker question (§3.10).
 *
 * The write-all property is pinned at the SEAM rather than through this
 * function (§3.12). A short write is not stageable through
 * `appendAuditRecord` — that would need a filesystem filled mid-write on
 * a test host — but "cannot return without writing everything, or raise"
 * is a property of `writeRecordLine` alone, and a non-blocking
 * descriptor stages it in one call. That is why the write is a named
 * export rather than an inline call, the same device the recovery arms
 * use to reach `recoveryFor` directly.
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
import { closeSync, constants, existsSync, lstatSync, openSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** The audit file name the runtime and its consumers agree on (§5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

/** Append-only, create-if-absent, never through a symlink (§4.6). */
const SINK_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/** Owner read/write only — the record at rest (§5.5). */
const SINK_MODE = 0o600;

/**
 * Writes `line` to an open descriptor and returns only when every byte of
 * it has landed; otherwise it raises. The fd form of `writeFileSync` loops
 * over partial writes, where `writeSync` is one `write(2)` that reports a
 * short count as a success (see the header).
 *
 * Exported so the property can be measured where it is stageable (§3.12):
 * the sink descriptor `appendAuditRecord` opens is always blocking, so a
 * short write cannot be provoked through that surface, while on a
 * non-blocking descriptor it is one call away.
 */
export function writeRecordLine(fd: number, line: string): void {
	writeFileSync(fd, line);
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
 * act — make the sink a plain writable file — is dead for all of them:
 * it is already one.
 *
 * The arms above are the modelled objects; every other code reaches the
 * general arm carrying its message. What decides whether that message is
 * honest is a RULE, stated here rather than a roster of the shapes it
 * generates, because the roster is what a later code silently falsifies
 * (§2.4, §3.11): the general arm's act — make the sink a plain,
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
		return `create the audit destination directory ${stateRoot} (mkdir -p), then re-run.`;
	}
	if (code === "ENOTDIR") {
		return (
			`replace ${nonDirectoryAncestor(sinkPath) ?? stateRoot} with a directory — it is not one, ` +
			`and nothing can be created beneath a plain file — then create ${stateRoot} (mkdir -p) and re-run.`
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
			`grant this account write and search permission on the audit destination directory ` +
			`${stateRoot} (chmod u+wx), then re-run — until its mode admits this account the sink there ` +
			`can be neither opened nor created, and cannot even be measured to say which.`
		);
	}
	if (code === "ENOSPC" || code === "EDQUOT") {
		return (
			`free space on the filesystem holding ${sinkPath}, or raise this account's quota on it, ` +
			`then re-run — the record was refused for want of room, not for want of permission, ` +
			`so nothing at that path is misconfigured and no mode there admits it.`
		);
	}
	if (code === "EROFS") {
		return (
			`remount the filesystem holding ${sinkPath} read-write, or point the state root at a ` +
			`writable filesystem, then re-run — while the mount refuses writes no permission or mode ` +
			`at that path can admit the record.`
		);
	}
	if (code === "EIO") {
		return (
			`no act at ${sinkPath} restores this record: the write reached the filesystem and the ` +
			`device or transport under it reported an error, so the record is lost. Restore the health ` +
			`of that filesystem — for a network mount, its connection — then re-run to resume the trail.`
		);
	}
	return (
		`make ${sinkPath} a plain file writable by this account, then re-run — ` +
		`a directory, a symlink, or another account's file at that path all refuse the append ` +
		`(the sink is never followed through a link, so the record cannot be redirected away from the path the gate reads).`
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
			`the state root ${JSON.stringify(stateRoot)} is not an absolute path, so the sink under it would ` +
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
		const fd = openSync(sinkPath, SINK_FLAGS, SINK_MODE);
		leaked = fd;
		// Write-all, not one `write(2)`: a short count discarded here is a
		// partial record reported as a success (see the header).
		writeRecordLine(fd, `${JSON.stringify(record)}\n`);
		leaked = undefined;
		closeSync(fd);
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
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
