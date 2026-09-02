/**
 * Fail-posture inventory (SPEC §3.9 "One inventory, one home") — the one
 * machine-readable table for every dependency the ENFORCEMENT LAYER stands
 * on, all three tiers, not only the runtime hosting this file. Rows are
 * keyed on failure shapes rather than components, and every fail-closed
 * row carries its justification in place so the choice is auditable where
 * it binds. Rows for a tier whose postures are compiled into its own
 * control flow (the local tier's fail-open chain, §3.2) are declarative
 * only: no runtime reader is owed, and none exists.
 */
export interface PostureRow {
	dependency: string;
	/** The failure shape the row governs — what can go wrong, not which file. */
	failureShape: string;
	posture: "open" | "closed";
	justification: string;
}

export const POSTURES: readonly PostureRow[] = [
	{
		dependency: "repo-root-discovery",
		failureShape:
			"no admissible .pi/ ancestor above the installed module (a .pi/ below the install root is rejected, never a root — §4.7)",
		posture: "open",
		justification:
			"Absent means never installed; the actor cannot repair the installation from inside a block (§3.9).",
	},
	{
		dependency: "audit-append",
		failureShape:
			"audit destination missing or unwritable — including a sink the fstat verdict refuses: not a regular " +
			"file (FIFO, device), more than one hard-link name, group/other mode bits, or another account's " +
			"ownership (includes the wrapped load-marker site at extension load)",
		posture: "open",
		justification: "Additive observability never moves a fail direction (§3.8).",
	},
	{
		dependency: "commit-format-helper",
		failureShape:
			"helper file absent from the bound helper dir at commit time (githook_source's fail-open miss in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation: absent means never installed here, which the acting party did not cause and cannot repair from inside a block (§3.9's machinery carve-out); the advice tier no-ops rather than wedging git (§3.2).",
	},
	{
		dependency: "commit-format-helper",
		failureShape:
			"helper file sources cleanly but does not define check_commit_subject (githook_require's guard in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation, same carve-out (§3.9): a present-but-incomplete helper degrades to allow, never to a false block under a wrong cause (§3.2).",
	},
	{
		dependency: "commit-format-measurement",
		failureShape:
			"live predicate handed a subject it cannot measure — a non-multibyte-capable measuring charmap or no capable counting tool with non-ASCII input (degraded environment), or subject bytes invalid in the measuring charmap (out-of-domain input)",
		posture: "closed",
		justification:
			"Present but cannot measure never vouches (§3.9's measurement rule; the carve-out covers the tier's machinery, not a live predicate's inputs): the input is the actor's own and the repair is theirs, the tier's --no-verify escape stands open beneath the refusal, and the degradation refuses only what it would mis-measure — pure ASCII stays exact in any charmap and keeps passing.",
	},
	{
		dependency: "seam-target",
		failureShape:
			"GHJIG_TEST_STATE_ROOT set but empty, relative, or not measurable as a directory by this account " +
			"(missing, not a directory, or refused)",
		posture: "closed",
		justification:
			"Present but cannot measure refuses the run (§3.9); a fallback would write the operational evidence surface from a test context — exactly what §5.5 forbids.",
	},
];
