/**
 * ghjig tier-1 runtime — extension entry (SPEC §3.2, §4.1, §4.6, §5.5).
 *
 * The factory performs registrations only: pi action methods are illegal
 * during extension loading, so everything that talks to the session runs
 * inside the `session_start` handler. The load marker is a plain-fs
 * append (legal at load) and the load site degrades open: a marker-write
 * failure warns and continues, never aborts extension load (§3.9,
 * `audit-append` row). `resolveStateRoot` is deliberately NOT wrapped —
 * an unusable seam refuses the run (fail closed, `seam-target` row).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendAuditRecord } from "./ghjig/audit.ts";
import { locateRepoRoot } from "./ghjig/locate.ts";
import { resolveStateRoot } from "./ghjig/state-root.ts";

export default function ghjig(pi: ExtensionAPI) {
	const repoRoot = locateRepoRoot();
	const { root: stateRoot, seamActive } = resolveStateRoot();

	// Wrapped load marker: appendAuditRecord never throws; with no seam and
	// no existing operational root this degrades open (nothing is created).
	appendAuditRecord(stateRoot, {
		category: "runtime",
		action: "ext-load",
		text: `ghjig runtime loaded from ${repoRoot}`,
	});

	// Self-announcing override (§4.6, §5.9): an active seam is never silent.
	if (seamActive) {
		appendAuditRecord(stateRoot, {
			category: "runtime",
			action: "seam-active",
			text: `state root overridden by test seam GHJIG_TEST_STATE_ROOT -> ${stateRoot}`,
		});
	}

	pi.on("session_start", () => {
		appendAuditRecord(stateRoot, {
			category: "runtime",
			action: "session-start",
			text: "session_start received; appending the registration entry",
		});
		pi.appendEntry("ghjig-registration", { repoRoot, stateRoot, seamActive });
	});
}
