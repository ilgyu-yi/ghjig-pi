/**
 * Dispatch admission — the bounded structured return, admitted on output
 * validity alone (SPEC §3.10; §4.9's sole-crossing clause).
 *
 * The one crossing is `<scratch>/return.json`. Admission demands: a
 * REGULAR FILE at the slot — the type verdict rides `lstat`, which does
 * not follow symlinks, so a FIFO (whose blocking open would freeze this
 * synchronous admit inside the extension host), a device, a directory,
 * or a symlinked slot refuses without ever being opened; at most
 * 64 KiB — an oversize return is refused WHOLE, never truncated into an
 * admission; strict JSON; the CLOSED schema
 * `{ ok: boolean, summary: string, reviewedHead?: string }` with unknown
 * keys refused — a minimum-match would admit a surface no contract
 * bounds. Anything the delegate printed on a stream is not the crossing
 * (§3.10's wrong-stream class lands here as a missing return).
 *
 * Every refusal cause below is a FIXED literal (§3.9's content-free
 * refusal records): no delegate byte, no operand, no filesystem detail
 * ever rides a cause. The five §3.10 outcome classes map onto them —
 * delegate absent and failed run and bound exceeded are decided by the
 * caller from the run shape; junk, partial, and wrong-stream land on the
 * two return-side causes here.
 */
import { lstatSync, readFileSync, type Stats } from "node:fs";

/** The return bound — beyond it the return is refused whole (§4.9). */
export const RETURN_LIMIT_BYTES = 64 * 1024;

/** The fixed content-free refusal causes, one per outcome class (§3.10). */
export const REFUSAL_CAUSES = {
	delegateAbsent:
		"dispatch refused: the delegate could not be run from this session's environment; nothing started and nothing is admitted",
	failedRun: "dispatch refused: the delegated run reported failure; no return is admitted from a failed run",
	boundExceeded: "dispatch refused: the delegate exceeded its run bound and was terminated; nothing is admitted",
	missingReturn:
		"dispatch refused: no readable return landed at the return slot; a delegate stream is not the crossing",
	malformedReturn:
		"dispatch refused: the return is oversize or malformed against the closed return schema; it is refused whole, never truncated",
	operandNamed:
		"dispatch refused: the return names a caller-held operand; the return channel is content-free and the return is refused whole",
} as const;

export type ReturnAdmission =
	| { admitted: true; ok: boolean; summary: string; reviewedHead?: string }
	| { admitted: false; cause: string };

const SCHEMA_KEYS = new Set(["ok", "summary", "reviewedHead"]);

export function admitReturn(returnPath: string): ReturnAdmission {
	// Type and bound are decided on the lstat BEFORE any read: an
	// unstattable return is missing; a non-regular slot (FIFO, device,
	// directory, symlink — lstat judges the link itself, never its target)
	// is malformed, refused without an open that could block or read
	// unbounded; an oversize one is malformed — decided without pulling
	// the oversize bytes into memory.
	let stat: Stats;
	try {
		stat = lstatSync(returnPath);
	} catch {
		return { admitted: false, cause: REFUSAL_CAUSES.missingReturn };
	}
	if (!stat.isFile()) {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	if (stat.size > RETURN_LIMIT_BYTES) {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	let raw: Buffer;
	try {
		raw = readFileSync(returnPath);
	} catch {
		return { admitted: false, cause: REFUSAL_CAUSES.missingReturn };
	}
	// Backstop for a return grown between the stat and the read.
	if (raw.byteLength > RETURN_LIMIT_BYTES) {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	for (const key of Object.keys(parsed)) {
		if (!SCHEMA_KEYS.has(key)) {
			return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
		}
	}
	const { ok, summary, reviewedHead } = parsed as { ok?: unknown; summary?: unknown; reviewedHead?: unknown };
	if (typeof ok !== "boolean" || typeof summary !== "string") {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	if (reviewedHead !== undefined && typeof reviewedHead !== "string") {
		return { admitted: false, cause: REFUSAL_CAUSES.malformedReturn };
	}
	return reviewedHead === undefined
		? { admitted: true, ok, summary }
		: { admitted: true, ok, summary, reviewedHead };
}
