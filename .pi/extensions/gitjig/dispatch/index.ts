/**
 * The dispatch instrument — `gitjig_dispatch` (SPEC §4.9 "The delegation
 * layer"; issue #88). `runDispatch` is the composed pipeline — provision
 * → run → admit → compare → operand scan → cleanup in `finally` — and
 * `registerDispatchTool` wraps it as the registered tool: one home, many
 * call sites (§4.9).
 *
 * The caller acts §1.4/§1.6/§1.7/§1.8 assign ride this dispatcher; where
 * a §3.3 row consumes the property, the dispatcher is a CALL SITE of the
 * predicate that row owns, never a second implementation (§3.11). The
 * named instance: holding and comparing the expected head is evidence
 * production for the §3.3 `merge-review` row. With the tree pinned at
 * provision, the compare consumes the return's `reviewedHead` and crosses
 * back as VALIDITY alone — byte-equal to the held hash → `"confirmed"`;
 * mismatch, absent, or unconfirmable → `"invalid"`, never an approve —
 * and neither operand ever enters the tool result, the outcome, or the
 * audit trail (§4.9's content-free return channels; §1.6's blind
 * compare). The mechanical outgoing-surface scan enforces the same rule
 * on the admitted summary: every hex run of ≥ 4 chars (either case) is
 * lowercased, and the return is refused whole with a fixed cause iff the
 * held hash contains the run or the run contains the held 7-prefix (§4.9
 * grounding in §3.9's content-free idiom; a paraphrased or re-encoded
 * operand is §4.9's injectable-context residual, not this scan's catch —
 * and the containment branch covers the held 7-prefix embedded in a
 * longer run, not an arbitrary interior slice padded into one, which
 * rides the same residual).
 *
 * Every dispatch act — admission and each refusal — lands at least one
 * `category:"dispatch"` record through the landed audit writer,
 * content-free: outcome and scratch-relative locators only (§5.5; the
 * sink itself fails open per §3.9's `audit-append` row, so a refusal
 * stands whether or not its record landed). Cleanup degrades OPEN: an
 * unremovable scratch warns on the audit trail and never converts a
 * decided outcome into a failure (§3.9).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendAuditRecord } from "../audit.ts";
import { admitReturn, REFUSAL_CAUSES } from "./admit.ts";
import { runDelegate } from "./executor.ts";
import {
	cleanupDispatchContext,
	PROVISION_REFUSAL_CAUSES,
	provisionDispatchContext,
	type DispatchContext,
} from "./provision.ts";

/** The tool name §4.9's delegation row records, verbatim — one name. */
export const DISPATCH_TOOL_NAME = "gitjig_dispatch";

/** Provision failure, refused through the composed pipeline (§3.9). */
const REFUSE_PROVISION =
	"dispatch refused: the isolated execution context could not be provisioned at the expected head; nothing ran";

/** Inadmissible argv from the tool surface — refused before any spawn. */
const REFUSE_ARGV = "dispatch refused: the delegate argv is not an admissible non-empty vector of strings";

/** Inadmissible brief from the tool surface — refused before any provision. */
const REFUSE_BRIEF = "dispatch refused: the dispatch brief is not an admissible string";

export type DispatchOutcome =
	| { disposition: "admitted"; ok: boolean; summary: string; compare?: "confirmed" | "invalid" }
	| { disposition: "refused"; cause: string };

/**
 * The single ruled scan contract: hex runs in `text` match
 * `/[0-9a-fA-F]{4,}/g`, each run is lowercased, and a run names the held
 * operand iff the held hash contains the run OR the run contains the held
 * 7-prefix. Anything else — unrelated hashes, UUID fragments — is left
 * alone: the scan pins the held operand, not hex at large (an
 * over-blocking scan makes every hash-adjacent summary undeliverable).
 */
function namesHeldOperand(text: string, heldHash: string): boolean {
	const runs = text.match(/[0-9a-fA-F]{4,}/g) ?? [];
	const prefix = heldHash.slice(0, 7);
	return runs.some((run) => {
		const lowered = run.toLowerCase();
		return heldHash.includes(lowered) || lowered.includes(prefix);
	});
}

export interface RunDispatchOptions {
	callerRepoRoot: string;
	stateRoot: string;
	brief: string;
	delegateArgv: string[];
	expectedRef?: string;
	timeoutMs?: number;
}

export async function runDispatch(options: RunDispatchOptions): Promise<DispatchOutcome> {
	// Content-free by construction: every `text` below is a fixed literal
	// or a fixed cause — no delegate byte, no operand, no absolute path.
	const record = (action: string, text: string): void => {
		appendAuditRecord(options.stateRoot, { category: "dispatch", action, text });
	};
	const refuse = (action: string, cause: string): DispatchOutcome => {
		record(action, cause);
		return { disposition: "refused", cause };
	};

	let context: DispatchContext;
	try {
		context = provisionDispatchContext(options.callerRepoRoot, {
			brief: options.brief,
			expectedRef: options.expectedRef,
		});
	} catch (error) {
		// A known provision cause passes through as-is (each is a fixed
		// content-free literal); anything else refuses on the generic cause.
		const thrown = error instanceof Error ? error.message : "";
		const known = (Object.values(PROVISION_REFUSAL_CAUSES) as string[]).includes(thrown);
		return refuse("refuse-provision", known ? thrown : REFUSE_PROVISION);
	}
	try {
		const run = await runDelegate(context, options.delegateArgv, { timeoutMs: options.timeoutMs });
		if (run.spawnFailed) {
			return refuse("refuse-delegate-absent", REFUSAL_CAUSES.delegateAbsent);
		}
		if (run.timedOut) {
			return refuse("refuse-bound-exceeded", REFUSAL_CAUSES.boundExceeded);
		}
		if (run.exitCode !== 0) {
			return refuse("refuse-failed-run", REFUSAL_CAUSES.failedRun);
		}
		const admission = admitReturn(context.returnPath);
		if (!admission.admitted) {
			return refuse("refuse-return", admission.cause);
		}
		if (namesHeldOperand(admission.summary, context.heldHash)) {
			return refuse("refuse-operand-named", REFUSAL_CAUSES.operandNamed);
		}
		const outcome: DispatchOutcome = { disposition: "admitted", ok: admission.ok, summary: admission.summary };
		if (options.expectedRef !== undefined) {
			// The blind compare (§1.6 via §4.9): validity alone crosses back.
			outcome.compare = admission.reviewedHead === context.heldHash ? "confirmed" : "invalid";
		}
		record("admitted", "dispatch admitted: the bounded return crossed from the return.json slot");
		return outcome;
	} finally {
		try {
			cleanupDispatchContext(context);
		} catch {
			// Degrade open (§3.9): the outcome above already decided; the
			// orphaned scratch is bounded by the OS temp root (provision header).
			record("cleanup-degraded", "dispatch cleanup degraded: the scratch could not be removed whole");
		}
	}
}

/**
 * Plain JSON schema, deliberately not a typebox construction: this module
 * is imported by the module suite under plain node, where the substrate's
 * bundled dependencies do not resolve — and the substrate's argument
 * validation accepts a schema without the typebox kind marker.
 */
const DISPATCH_PARAMS = {
	type: "object",
	properties: {
		brief: {
			type: "string",
			description: "The dispatch brief; written verbatim to the scratch's brief.md for the delegate.",
		},
		delegateArgv: {
			type: "array",
			items: { type: "string" },
			description: "The delegate as an argv vector, run with cwd = the provisioned tree.",
		},
		expectedRef: {
			type: "string",
			description:
				"Optional ref name, resolved exactly once in the caller repository at provision; " +
				"the return's reviewedHead is compared against the held hash and surfaces as validity alone.",
		},
	},
	required: ["brief", "delegateArgv"],
	additionalProperties: false,
};

interface DispatchToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function result(text: string, details: Record<string, unknown>): DispatchToolResult {
	return { content: [{ type: "text", text }], details };
}

export function registerDispatchTool(pi: ExtensionAPI, repoRoot: string, stateRoot: string): void {
	pi.registerTool({
		name: DISPATCH_TOOL_NAME,
		label: "Dispatch",
		description:
			"Dispatch a delegate into an isolated clone of this repository, pinned at a once-resolved head. " +
			"Locally, the delegate's writable world is the clone — the routes the clone plants back to the " +
			"caller repository are severed at provision — but the delegate runs in the caller's trust domain " +
			"and inherits its environment, credentials included: remote reach through inherited credentials " +
			"is not confined. The only thing that crosses back is a bounded structured return, and a compare " +
			"outcome surfaces as validity alone.",
		parameters: DISPATCH_PARAMS as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
		async execute(_toolCallId, params) {
			const delegateArgv: unknown = params.delegateArgv;
			if (
				!Array.isArray(delegateArgv) ||
				delegateArgv.length === 0 ||
				delegateArgv.some((entry) => typeof entry !== "string")
			) {
				appendAuditRecord(stateRoot, { category: "dispatch", action: "refuse-argv", text: REFUSE_ARGV });
				return result(REFUSE_ARGV, { disposition: "refused" });
			}
			const brief: unknown = params.brief;
			if (typeof brief !== "string") {
				// No coercion: a `String()`-coerced "undefined" brief is a
				// silently wrong dispatch, not an admitted one.
				appendAuditRecord(stateRoot, { category: "dispatch", action: "refuse-brief", text: REFUSE_BRIEF });
				return result(REFUSE_BRIEF, { disposition: "refused" });
			}
			const outcome = await runDispatch({
				callerRepoRoot: repoRoot,
				stateRoot,
				brief,
				delegateArgv: delegateArgv as string[],
				expectedRef: typeof params.expectedRef === "string" ? params.expectedRef : undefined,
			});
			if (outcome.disposition === "refused") {
				return result(outcome.cause, { disposition: "refused" });
			}
			const compareClause = outcome.compare === undefined ? "" : `; compare ${outcome.compare}`;
			return result(`dispatch admitted (ok: ${outcome.ok})${compareClause}: ${outcome.summary}`, {
				disposition: "admitted",
				ok: outcome.ok,
				...(outcome.compare === undefined ? {} : { compare: outcome.compare }),
			});
		},
	});
}
