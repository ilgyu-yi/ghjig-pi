/**
 * gitjig tier-1 runtime — extension entry (SPEC §3.2, §4.1, §4.6, §5.5).
 *
 * The factory performs registrations only: pi action methods are illegal
 * during extension loading, so everything that talks to the session runs
 * inside the `session_start` handler. The load marker is a plain-fs
 * append (legal at load) and the load site degrades open: a marker-write
 * failure warns and continues, never aborts extension load (§3.9,
 * `audit-append` row). `resolveStateRoot` is deliberately NOT wrapped —
 * an unusable seam refuses the run (fail closed, `seam-target` row).
 *
 * Because the audit sink fails open, whether it is live is itself
 * evidence: every append outcome of the session is folded into
 * `auditWritable` on the durable `gitjig-registration` entry, so a reader
 * of the session record can tell a live sink from a dead one instead of
 * having to have watched the console (§3.9, §5.9). This is observability
 * only — the fail direction stays open (§3.8).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendAuditRecord } from "./gitjig/audit.ts";
import { maybeAdviseBindState } from "./gitjig/bind-state.ts";
import { registerDispatchTool } from "./gitjig/dispatch/index.ts";
import { locateRepoRoot } from "./gitjig/locate.ts";
import { registerPublishTool } from "./gitjig/publish/index.ts";
import { resolveStateRoot } from "./gitjig/state-root.ts";

export default function gitjig(pi: ExtensionAPI) {
	const repoRoot = locateRepoRoot();
	const { root: stateRoot, seamActive } = resolveStateRoot();

	// The egress publish boundary (§3.3's egress row): registration is
	// load-legal; every action the tool takes runs inside its execute.
	registerPublishTool(pi, repoRoot, stateRoot);

	// The delegation layer (§4.9): one dispatcher, registered here as its
	// tool call site; every act it takes runs inside its execute.
	registerDispatchTool(pi, repoRoot, stateRoot);

	// Every append outcome of this session, folded: false the moment any
	// append degrades open. Reported on the registration entry below.
	let auditWritable = true;
	const record = (action: string, text: string): void => {
		auditWritable = appendAuditRecord(stateRoot, { category: "runtime", action, text }) && auditWritable;
	};

	// Wrapped load marker: appendAuditRecord never throws; with no seam and
	// no existing operational root the record itself creates nothing and
	// degrades open. The bind advisory below is what first materializes the
	// root, for its TTL stamp — so from a second session onward the record
	// lands in a directory that session-start work, not this call, created.
	// The paths are quoted and split across lines because a filesystem path
	// may itself contain a quote or a newline: write-time encoding is what
	// keeps this one record on one line (§5.5).
	record("ext-load", `gitjig runtime loaded from "${repoRoot}"\nstate root "${stateRoot}"`);

	// Self-announcing override (§4.6, §5.9): an active seam is never silent.
	if (seamActive) {
		record("seam-active", `state root overridden by test seam GITJIG_TEST_STATE_ROOT -> "${stateRoot}"`);
	}

	pi.on("session_start", () => {
		record("session-start", "session_start received; appending the registration entry");
		pi.appendEntry("gitjig-registration", { repoRoot, stateRoot, seamActive, auditWritable });
		// Tier-2 bind advisory (§5.2, §5.9): classifies the clone the SESSION
		// stands in from the configuration git resolves; debounced,
		// timeout-bounded, and degrading to silence — never a session abort.
		maybeAdviseBindState(pi, stateRoot);
	});
}
