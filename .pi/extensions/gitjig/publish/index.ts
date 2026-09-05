/**
 * The egress publish instrument — the `gitjig_publish` tool (SPEC §3.3
 * "egress publish-boundary semantics"; the class row's tier-1 home;
 * issue #83). Registration only: the factory-legal surface, called from
 * the extension entry at load.
 *
 * Flow per call: destination admission → secret scan → on clean,
 * neutralization → the bounded executor. Every refusal lands exactly one
 * `category:"egress"` audit record and a tool result carrying validity
 * alone — disposition, pattern IDs, line locators — never the matched
 * text and never the body (§3.8's refusal-record rule; §4.9's measured
 * ground: a registered tool's result enters the run's transcript, so a
 * result a composer may relay stays content-free about what the refusal
 * withheld). A scan machinery failure (`PatternSourceError`) refuses
 * fail-closed on its own content-free cause (§3.9
 * `egress-publish-patterns`) — never the out-of-domain disposition, and
 * never a publish. The audit sink itself fails open (§3.9
 * `audit-append`): a refusal stands whether or not its record landed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendAuditRecord } from "../audit.ts";
import { neutralizeBody } from "./neutralize.ts";
import { ghCommentArgv, isPublishDestination, runPublishChild } from "./executor.ts";
import { PatternSourceError, scanBody } from "./scan.ts";

/** The tool name §3.3's egress row records, verbatim. */
export const PUBLISH_TOOL_NAME = "gitjig_publish";

const PublishParams = Type.Object({
	body: Type.String({ description: "The exact text to publish; scanned and neutralized before any send." }),
	destination: Type.Object({
		kind: Type.Union([Type.Literal("issue-comment"), Type.Literal("pr-comment")]),
		number: Type.Number({ description: "The issue or pull request number the comment lands on." }),
	}),
});

interface PublishResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function result(text: string, details: Record<string, unknown>): PublishResult {
	return { content: [{ type: "text", text }], details };
}

export function registerPublishTool(pi: ExtensionAPI, repoRoot: string, stateRoot: string): void {
	const record = (action: string, text: string): void => {
		appendAuditRecord(stateRoot, { category: "egress", action, text });
	};

	pi.registerTool({
		name: PUBLISH_TOOL_NAME,
		label: "Publish",
		description:
			"Publish repository-derived text to the platform (issue or PR comment). " +
			"The body is scanned against the committed secret patterns and refused on a match; " +
			"relayed mentions and actionable references are neutralized to inert spellings before the send.",
		parameters: PublishParams,
		async execute(_toolCallId, params) {
			// The destination is the actor's explicit structured target; an
			// inadmissible one refuses content-free, never publishes (§3.3).
			const destination: unknown = params.destination;
			if (!isPublishDestination(destination)) {
				const text = "publish refused: the destination is not an admissible structured target";
				record("refuse-destination", text);
				return result(text, { disposition: "refuse-destination" });
			}

			let scan;
			try {
				scan = scanBody(params.body);
			} catch (error) {
				// Fail closed on scan machinery (§3.9 egress-publish-patterns):
				// PatternSourceError messages are fixed content-free literals;
				// any other throw is refused on a fixed cause of this module's
				// own — a raw message could embed paths or content.
				const cause =
					error instanceof PatternSourceError
						? error.message
						: "the scan machinery failed before a verdict";
				const text = `publish refused (fail closed): ${cause}`;
				record("refuse-machinery", text);
				return result(text, { disposition: "refuse-machinery" });
			}

			if (scan.disposition === "refuse-out-of-domain") {
				const text =
					"publish refused: disposition refuse-out-of-domain; the body is outside the " +
					"line-and-pattern measurement domain; no pattern was consulted — recompose the body and call again";
				record("refuse-out-of-domain", text);
				return result(text, { disposition: "refuse-out-of-domain" });
			}

			if (scan.disposition === "refuse-match") {
				// Pattern IDs are format-checked lowercase-hyphen tokens and the
				// locators are numbers, so this composition carries no body byte.
				const text =
					"publish refused: disposition refuse-match; " +
					`patterns ${scan.patternIds.join(", ")}; lines ${scan.lines.join(", ")} — ` +
					"respell or remove the located spans and call again";
				record("refuse-match", text);
				return result(text, {
					disposition: "refuse-match",
					patternIds: scan.patternIds,
					lines: scan.lines,
				});
			}

			const outcome = await runPublishChild(ghCommentArgv(destination), neutralizeBody(params.body), repoRoot);
			if (outcome.outcome === "published") {
				// The one surface child bytes may cross: the URL validated whole
				// against the comment-URL shape (§3.10's output validity).
				return result(`published: ${outcome.url}`, { disposition: "published", url: outcome.url });
			}
			if (outcome.outcome === "outcome-unverified") {
				const text =
					"outcome-unverified: the send left the process and no valid outcome shape arrived on stdout; " +
					"neither publication nor withholding is claimed";
				record("outcome-unverified", text);
				return result(text, { disposition: "outcome-unverified" });
			}
			const text = `publish refused: ${outcome.cause}`;
			record("refuse-delegated", text);
			return result(text, { disposition: "refuse-delegated" });
		},
	});
}
