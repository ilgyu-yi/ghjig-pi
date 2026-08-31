/**
 * Fail-posture inventory (SPEC §3.9) — one machine-readable table for
 * exactly the dependencies this runtime ships, keyed on failure shapes
 * rather than components. Every fail-closed row carries its
 * justification in place so the choice is auditable where it binds.
 *
 * Keying on shapes is why one component can contribute several rows: the
 * measurement chain a gate stands on can fail by not finding the ref
 * store, by not deciding what a ref is, by not naming the default branch,
 * by not reading the command, and by not determining what a bare push
 * lands on — five failures, five different things left unmeasured. One
 * row for all of them would declare a single posture and hide which
 * measurement was actually lost.
 *
 * Nothing here is evaluated at module scope beyond the table itself: the
 * inventory is read during extension loading, and a throw there aborts
 * the load, which the substrate reports as a non-zero exit — the
 * fail-closed outcome the open rows deny. The accessor therefore refuses
 * an unknown key at the CALL, never at load.
 */
export interface PostureRow {
	dependency: string;
	/** The failure shape the row governs — what can go wrong, not which file. */
	failureShape: string;
	posture: "open" | "closed";
	justification: string;
	/**
	 * What the surface must say when this row's open posture DISARMS a
	 * check — a check that would otherwise have run did not run, and a
	 * reader must never mistake that for a passing one (§3.9). Absent on
	 * an open row whose openness is by-design inertness rather than
	 * degradation: where nothing was examined, nothing is recorded (§3.8).
	 */
	degradationSignal?: string;
}

export const POSTURES: readonly PostureRow[] = [
	{
		dependency: "repo-root-discovery",
		failureShape:
			"no admissible .pi/ ancestor above the installed module (a .pi/ below the install root is rejected, never a root — §4.7)",
		posture: "open",
		justification:
			"Absent means never installed; the actor cannot repair the installation from inside a block (§3.9).",
		degradationSignal:
			"repository-root discovery degraded to the structural root: every check that depends on knowing the governed root is NOT ENFORCED for this run",
	},
	{
		dependency: "audit-append",
		failureShape:
			"audit destination missing, unwritable, or not a regular file (a link at the sink path is refused, never followed — §4.6)",
		posture: "open",
		justification: "Additive observability never moves a fail direction (§3.8).",
		degradationSignal:
			"no audit evidence is being recorded for this run — the audit trail is NOT ENFORCED",
	},
	{
		dependency: "seam-target",
		failureShape:
			"the state seam is set but empty, relative, missing, not a directory, or names the governed repository root, a strict descendant of it, or a directory containing it",
		posture: "closed",
		justification:
			"Present but cannot measure refuses the run (§3.9); a fallback would write the operational evidence surface from a test context — exactly what §5.5 forbids, and a seam the governed tree can reach lets that tree's own content decide where the evidence lands.",
	},
	{
		dependency: "git-commondir",
		failureShape:
			"a .git entry is present but the gitdir/commondir pair cannot be resolved to one ref store (never keyed on an absent commondir file — an ordinary clone has none)",
		posture: "closed",
		justification:
			"The ref store is present and unreadable, not absent: a decision made without it would vouch for a repository shape nothing measured (§3.9).",
	},
	{
		dependency: "ref-identity",
		failureShape: "the target ref resolves through neither identity leg, so what the ref IS stays undecided",
		posture: "closed",
		justification:
			"An undecided ref is the one case where a spelling could pass for a protected branch; refusing withholds an allow nothing measured (§3.9). " +
			"The false-block this buys, named here rather than discovered in operation (§3.6): a push whose destination exists only on the far end — " +
			"creating a remote branch this repository holds under no name — resolves through neither leg and is refused. " +
			"The recovery is the one this row already carries: name a destination the repository holds.",
	},
	{
		dependency: "default-branch-source",
		failureShape: "origin/HEAD is absent or unparseable, so the default branch cannot be named",
		posture: "closed",
		justification:
			"The remote is present and its pointer unreadable; naming no default branch would silently unprotect the branch most in need of it (§3.9).",
	},
	{
		dependency: "command-parse",
		failureShape: "the command string cannot be decided — quoting, substitution, or an unrecognised form leaves the intent unread",
		posture: "closed",
		justification:
			"An unread command is present and unmeasurable; allowing it would vouch for an intent nothing parsed (§3.9).",
	},
	{
		dependency: "push-target-resolution",
		failureShape:
			"the effective push.default could not be determined across the configuration precedence chain (never the local config file alone)",
		posture: "closed",
		justification:
			"What a bare push lands on is decided by the effective value; a decision taken from a partial view is the wrong-allow direction (§3.9).",
	},
	{
		dependency: "gate-scope",
		failureShape:
			"the working directory is outside the governed root — not that root and not below it, or no repository at all — or inside a repository nested below it, which binds at its own root (§4.7)",
		posture: "open",
		justification:
			"Outside the governed root the shell is a guardrail, not a sandbox (§4.6): enforcement is transparently inert by design, and nothing was examined, so nothing is recorded (§3.8).",
	},
];

/**
 * The row for `key`, or a refusal naming the key.
 *
 * Callers read their own degradation wording from the row rather than
 * restating it, so the surface an operator sees and the inventory a
 * reviewer reads are one claim, not two that can drift apart.
 */
export function posture(key: string): PostureRow {
	const row = POSTURES.find((candidate) => candidate.dependency === key);
	if (row === undefined) {
		throw new Error(
			`[ghjig] no fail-posture row is declared for "${key}" — a dependency with no declared ` +
				`posture is a fail direction nobody chose (§3.9). Recovery: declare its row in the ` +
				`posture inventory, or correct the key at this call site.`,
		);
	}
	return row;
}
