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
 */
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The audit file name the runtime and its consumers agree on (§5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

/** Append-only, create-if-absent, never through a symlink (§4.6). */
const SINK_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/** Owner read/write only — the record at rest (§5.5). */
const SINK_MODE = 0o600;

/**
 * The recovery live at THIS surface for the failure that actually
 * occurred (§3.11 — arm-scoped remediation; a message naming a dead
 * recovery is worse than one naming none). Two shapes, two recoveries:
 * the destination directory is absent (create it), or the sink path
 * itself is unusable (make it a plain, owner-writable file).
 */
function recoveryFor(error: unknown, stateRoot: string, sinkPath: string): string {
	const code = (error as { code?: string } | null)?.code;
	if (code === "ENOENT") {
		return `create the audit destination directory ${stateRoot} (mkdir -p), then re-run.`;
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
	let fd: number | undefined;
	try {
		fd = openSync(sinkPath, SINK_FLAGS, SINK_MODE);
		writeSync(fd, `${JSON.stringify(record)}\n`);
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
		if (fd !== undefined) {
			closeSync(fd);
		}
	}
}
