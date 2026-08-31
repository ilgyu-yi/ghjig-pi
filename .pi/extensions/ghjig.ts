/**
 * ghjig tier-1 runtime — extension entry (SPEC §3.2, §3.3, §4.1, §4.6,
 * §5.5).
 *
 * The factory performs registrations only: pi action methods are illegal
 * during extension loading, so everything that talks to the session runs
 * inside the `session_start` handler. The load marker is a plain-fs
 * append (legal at load) and the load site degrades open: a marker-write
 * failure warns and continues, never aborts extension load (§3.9,
 * `audit-append` row). `resolveStateRoot` is deliberately NOT wrapped —
 * an unusable seam refuses the run (fail closed, `seam-target` row), and
 * the refusal stays HERE rather than moving into the tool-call handler:
 * the substrate exits non-zero on a failed extension load, so no unarmed
 * session exists, while a refusal deferred to the handler would start the
 * session under a relocated state root for every path that is not a tool
 * call.
 *
 * Because the audit sink fails open, whether it is live is itself
 * evidence: every append outcome of the session is folded into
 * `auditWritable` on the durable `ghjig-registration` entry, so a reader
 * of the session record can tell a live sink from a dead one instead of
 * having to have watched the console (§3.9). This is observability only —
 * the fail direction stays open (§3.8).
 *
 * Two gate surfaces are registered here and decided elsewhere: the
 * protected-branch gate on the shell tool call (§3.3), and the
 * `/ghjig-topic` affordance that repairs a block (§3.11). Both are
 * registrations; neither runs anything at load.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendAuditRecord } from "./ghjig/audit.ts";
import { applyGate } from "./ghjig/gate.ts";
import { locateRepoRoot } from "./ghjig/locate.ts";
import { resolveStateRoot } from "./ghjig/state-root.ts";
import { createTopicBranch } from "./ghjig/topic.ts";

export default function ghjig(pi: ExtensionAPI) {
	const repoRoot = locateRepoRoot();
	const { root: stateRoot, seamActive } = resolveStateRoot();

	// Every append outcome of this session, folded: false the moment any
	// append degrades open. Reported on the registration entry below.
	let auditWritable = true;
	const record = (action: string, text: string): void => {
		auditWritable = appendAuditRecord(stateRoot, { category: "runtime", action, text }) && auditWritable;
	};

	// Wrapped load marker: appendAuditRecord never throws; with no seam and
	// no existing operational root this degrades open (nothing is created).
	// The paths are quoted and split across lines because a filesystem path
	// may itself contain a quote or a newline: write-time encoding is what
	// keeps this one record on one line (§5.5).
	record("ext-load", `ghjig runtime loaded from "${repoRoot}"\nstate root "${stateRoot}"`);

	// Self-announcing override (§4.6, §5.9): an active seam is never silent.
	if (seamActive) {
		record("seam-active", `state root overridden by test seam GHJIG_TEST_STATE_ROOT -> "${stateRoot}"`);
	}

	pi.on("session_start", () => {
		record("session-start", "session_start received; appending the registration entry");
		pi.appendEntry("ghjig-registration", { repoRoot, stateRoot, seamActive, auditWritable });
	});

	// The protected-branch gate (§3.3), bound at the irreversible moment: the
	// call is examined before its first byte executes, which is what keeps a
	// command from minting its own authorization (§3.8).
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") {
			return;
		}
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") {
			return;
		}
		// The session's own working directory, as the substrate reports it —
		// the directory the call will run in, never an ambient reading (§4.6) —
		// and the governed root the runtime self-located to, which is what
		// scopes the decision to the repository this shell governs.
		const verdict = applyGate({ cwd: ctx.cwd, command, stateRoot, governedRoot: repoRoot });
		if (verdict.decision === "allow") {
			return;
		}
		return { block: true, reason: verdict.message };
	});

	// The in-flow authoring affordance the gate owes (§3.11), registered here
	// and decided in its own module.
	pi.registerCommand("ghjig-topic", {
		description: "Create a topic branch and switch to it, named as SPEC §1.1's branch convention prescribes",
		handler: async (args, ctx) => {
			const result = createTopicBranch({ cwd: ctx.cwd, branch: args });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});
}
