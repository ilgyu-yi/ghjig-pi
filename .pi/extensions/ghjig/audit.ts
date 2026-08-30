/**
 * Audit primitive — one record per line (SPEC §5.5).
 *
 * Each record is a single JSON object on its own line in
 * `<stateRoot>/audit.jsonl`. Free text passes through `JSON.stringify`
 * at write time, so embedded newlines and control characters can never
 * split a record.
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
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** The audit file name the runtime and its consumers agree on (§5.5). */
export const AUDIT_FILE_NAME = "audit.jsonl";

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
	try {
		appendFileSync(join(stateRoot, AUDIT_FILE_NAME), `${JSON.stringify(record)}\n`);
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			`[ghjig] audit append failed: no audit evidence is being recorded for this run — ` +
				`the audit trail is NOT ENFORCED. Degrading open rather than blocking (§3.9). ` +
				`Cause: ${reason}`,
		);
		return false;
	}
}
