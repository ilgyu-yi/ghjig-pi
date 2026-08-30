/**
 * Fail-posture inventory (SPEC §3.9) — one machine-readable table for
 * exactly the dependencies this runtime ships, keyed on failure shapes
 * rather than components. Every fail-closed row carries its
 * justification in place so the choice is auditable where it binds.
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
			"audit destination missing or unwritable (includes the wrapped load-marker site at extension load)",
		posture: "open",
		justification: "Additive observability never moves a fail direction (§3.8).",
	},
	{
		dependency: "seam-target",
		failureShape: "GHJIG_TEST_STATE_ROOT set but empty, relative, missing, or not a directory",
		posture: "closed",
		justification:
			"Present but cannot measure refuses the run (§3.9); a fallback would write the operational evidence surface from a test context — exactly what §5.5 forbids.",
	},
];
