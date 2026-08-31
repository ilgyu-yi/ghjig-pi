/**
 * Audit primitive — one record per line (SPEC §5.5).
 *
 * Each record is a single JSON object on its own line in
 * `<stateRoot>/audit.jsonl`. Free text passes through `JSON.stringify`
 * at write time, so embedded newlines and control characters can never
 * split a record.
 *
 * The destination the writer opens is the file the reader reads (§4.6):
 * the sink is opened with the no-follow flag where the platform has one
 * and, as a floor for platforms that do not, refused outright when the
 * path already holds something that is not a regular file. A link at the
 * audit path would otherwise send the evidence somewhere else while both
 * the write and the read report clean. The sink is created restrictively
 * (owner read/write only), because it is evidence about the actor.
 *
 * Fail posture (§3.9, `audit-append` row): a destination that is missing,
 * unwritable, or not a regular file degrades OPEN — warn, return `false`,
 * never throw. Two failure shapes, two messages (§3.11): "there is no
 * destination" and "the destination is not a destination" have different
 * remedies, and one shared string names the wrong one for half its
 * readers. Each message states plainly that nothing is being recorded —
 * a reader must never have to infer a disarmed check from its
 * consequence — and the returned boolean is what lets a caller record
 * that outcome on a durable surface. This primitive also never creates
 * the destination directory: state-root creation belongs to the first
 * operational writer, not to observability (§3.8 — additive
 * observability never moves a fail direction).
 */
import { closeSync, constants, lstatSync, openSync, type Stats, writeSync } from "node:fs";
import { join } from "node:path";
import { posture } from "./postures.ts";

/** The audit file name the runtime and its consumers agree on (§5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

/**
 * Append, create, write-only — plus no-follow where the platform defines
 * it. The `?? 0` is load-bearing: an undefined flag would make the bitwise
 * OR `NaN` and fail EVERY append, turning a hardening measure into a total
 * outage of the evidence surface (§3.12 — a check that can false-red is
 * itself a defect). Where the flag is absent, the pre-check below is the
 * floor that still refuses a non-regular destination.
 */
const SINK_FLAGS =
	constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);

/** Owner-only: the audit trail is evidence about the actor (§4.6). */
const SINK_MODE = 0o600;

export interface AuditInput {
	category: string;
	action: string;
	/**
	 * The deciding arm, where the record reports a decision — what makes a
	 * decision attributable (§3.8: named, never counted). Absent on records
	 * that report an event rather than a decision, so a reader never has to
	 * read an empty arm as an unnamed one.
	 */
	arm?: string;
	/** Free text; encoded at write time, round-trips intact. */
	text: string;
}

/** What sits at `path` without following a link, or `undefined` if nothing does. */
function entryAt(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/** How to name a destination that is not the regular file the reader reads. */
function describeEntry(entry: Stats): string {
	if (entry.isSymbolicLink()) {
		return "a symbolic link";
	}
	if (entry.isDirectory()) {
		return "a directory";
	}
	return "not a regular file";
}

/**
 * The one degradation surface, classified into its two shapes.
 *
 * The wording of the disarm comes from the posture inventory itself, so
 * the row a reviewer reads and the line an operator sees are one claim.
 */
function warnDegraded(stateRoot: string, destination: string, cause: unknown): void {
	const signal = posture("audit-append").degradationSignal;
	const entry = entryAt(destination);
	if (entry !== undefined && !entry.isFile()) {
		console.warn(
			`[ghjig] audit append refused: the audit destination ${destination} is ${describeEntry(entry)}, ` +
				`not the regular file the reader reads, and the write was not redirected through it (§4.6). ` +
				`${signal}. Recovery: remove the entry at that path — the runtime creates the sink itself ` +
				`on the next append.`,
		);
		return;
	}
	const reason = cause instanceof Error ? cause.message : String(cause);
	console.warn(
		`[ghjig] audit append failed: ${signal}. Degrading open rather than blocking (§3.9). ` +
			`Recovery: create the state root directory ${stateRoot} (or point the run at an existing one) ` +
			`so the sink can be opened. Cause: ${reason}`,
	);
}

export function appendAuditRecord(stateRoot: string, input: AuditInput): boolean {
	const destination = join(stateRoot, AUDIT_FILE_NAME);
	const record = {
		timestamp: new Date().toISOString(),
		category: input.category,
		action: input.action,
		...(input.arm === undefined ? {} : { arm: input.arm }),
		text: input.text,
	};

	// The pre-check floor: a destination that already exists as anything
	// other than a regular file is refused before any open, so the guarantee
	// holds identically where the no-follow flag is unavailable.
	const existing = entryAt(destination);
	if (existing !== undefined && !existing.isFile()) {
		warnDegraded(stateRoot, destination, "the destination is not a regular file");
		return false;
	}

	let sink: number;
	try {
		sink = openSync(destination, SINK_FLAGS, SINK_MODE);
	} catch (error) {
		warnDegraded(stateRoot, destination, error);
		return false;
	}
	try {
		writeSync(sink, `${JSON.stringify(record)}\n`);
		return true;
	} catch (error) {
		warnDegraded(stateRoot, destination, error);
		return false;
	} finally {
		try {
			closeSync(sink);
		} catch {
			// A close that fails cannot un-write what was already appended, and
			// this primitive owes its caller an answer, never a throw (§3.9).
		}
	}
}
