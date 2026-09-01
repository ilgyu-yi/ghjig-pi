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
 *   - `O_NOFOLLOW` — write-target equals read-target (§4.6). A symlink
 *     planted at the sink path would send every record somewhere the
 *     consuming gate never reads, and both sides would report clean: the
 *     write succeeds, the read finds nothing. The open refuses the link
 *     instead of following it, and the refusal degrades open like any
 *     other unwritable destination.
 *   - mode `0600` — the record at rest is readable only by the account
 *     that writes it (§5.5). Passed on the create so the bits do not
 *     depend on the ambient umask; the sink is a file only this runtime
 *     writes, so no legitimate flow is refused (§3.6 obligation (i)).
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
 * The record is written with the fd form of `writeFileSync`, never with
 * `writeSync`. `writeSync` is one `write(2)`: it returns a byte COUNT,
 * and a count smaller than the payload leaves a record with no trailing
 * newline for the next append to concatenate onto — the one malformed
 * line the format above says can never occur — while the append returns
 * `true` and a durable registration entry folds a clean `auditWritable`.
 * That is the same false success the close handling below exists to
 * remove, on the write side. The fd form loops until the buffer drains
 * and raises the underlying error when it cannot, so the append either
 * writes the whole record or takes the degradation path.
 *
 * That short write is not stageable through this surface, and the code
 * carries the property by construction rather than by an arm (§3.12):
 * the sink descriptor is always blocking, where a pipe write completes
 * rather than shortens, and a regular-file write shortens only on a
 * mid-write `ENOSPC` or a signal. The module's own text cites a network
 * filesystem as why the close is handled at all; this is the write side
 * of that premise.
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
import { dirname, join } from "node:path";

/** The audit file name the runtime and its consumers agree on (§5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

/** Append-only, create-if-absent, never through a symlink (§4.6). */
const SINK_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/** Owner read/write only — the record at rest (§5.5). */
const SINK_MODE = 0o600;

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
 * One shape is UNMODELLED and reaches the general arm carrying its
 * message, stated here rather than left to be inferred (§3.11): an
 * `EACCES` raised by an unsearchable ancestor, where the destination
 * cannot be measured at all. It is not repaired at the sink path the
 * message names; it degrades open with the cause reported, which is
 * where the message already stops short.
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

export interface AuditInput {
	category: string;
	action: string;
	/** Free text; encoded at write time, round-trips intact. */
	text: string;
}

export function appendAuditRecord(stateRoot: string, input: AuditInput): boolean {
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
		// record without its newline reported as a success (see the header).
		writeFileSync(fd, `${JSON.stringify(record)}\n`);
		leaked = undefined;
		closeSync(fd);
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			`[ghjig] audit append failed: no audit evidence is being recorded for this run — ` +
				`the audit trail is NOT ENFORCED. Degrading open rather than blocking (§3.9). ` +
				`Cause: ${reason}. ` +
				`Recovery: ${recoveryFor(error, stateRoot, sinkPath)}`,
		);
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
