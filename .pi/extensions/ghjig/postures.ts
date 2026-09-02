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
		dependency: "branch-guard-helper",
		failureShape:
			"helper file absent from the bound helper dir at push time (githook_source's fail-open miss in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation: absent means never installed here, which the acting party did not cause and cannot repair from inside a block (§3.9's machinery carve-out); the advice tier no-ops rather than wedging git (§3.2).",
	},
	{
		dependency: "branch-guard-helper",
		failureShape:
			"helper file sources cleanly but does not define is_protected_branch (githook_require's guard in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation, same carve-out (§3.9): a present-but-incomplete helper degrades to allow, never to a false block under a wrong cause (§3.2).",
	},
	{
		dependency: "branch-guard-derivation",
		failureShape:
			"protected identity P underivable — stage 1 (local refs/remotes/origin/HEAD pointer) and stage 2 (ls-remote measurement, push surface only) both fail, stage-2 failure keyed by outcome: non-zero exit or empty/unparseable output (SPEC §3.3)",
		posture: "open",
		justification:
			"Machinery degradation on §3.9's absent-dependency side: an absent pointer is clone-configuration state the acting party's push did not cause; the gate disarms for the run and says so plainly — one audit warn record stating the gate is not enforced (§3.9's degradation-signal rule), the observable separating a disarmed allow from an ordinary allow.",
	},
	{
		dependency: "branch-guard-derivation-fallback",
		failureShape:
			"stage 1 alone fails (local refs/remotes/origin/HEAD pointer absent) at the push surface, where stage 2 can still measure the remote's advertised default (SPEC §3.3)",
		posture: "closed",
		justification:
			"A measurement, never a guess (§3.9's loader rule): stage-1 absence alone never disarms the gate — the push surface re-measures P from the remote and enforcement stands; only both stages failing reaches the open branch-guard-derivation row. The residual — no portable timeout, so the second connection can hang — is enumerated at SPEC §3.3 with the advertisement-precedes-hook justification; the commit surface never reaches stage 2 (an offline commit must not open a network connection).",
	},
	{
		dependency: "branch-guard-destination",
		failureShape:
			"live predicate handed a push target ASCII-case-fold-equal to P but byte-unequal — whether it lands on the protected ref is decided by the remote's filesystem semantics, unobservable client-side (SPEC §3.3, §3.9's unverifiable-destination clause)",
		posture: "closed",
		justification:
			"An unverifiable destination never vouches (§3.9; the carve-out covers the tier's machinery, not a live predicate's inputs): the input is the actor's own and the repair is theirs, the tier's --no-verify escape stands open beneath the refusal, and the named false-block cost (§3.6) — a genuinely distinct case-variant branch is over-blocked — is reversible.",
	},
	{
		dependency: "secret-scan-helper",
		failureShape:
			"secret_scan.sh absent from the bound helper dir at commit time (githook_source's fail-open miss in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation: absent means never installed here, which the acting party did not cause and cannot repair from inside a block (§3.9's machinery carve-out); the advice tier no-ops rather than wedging git (§3.2).",
	},
	{
		dependency: "secret-scan-helper",
		failureShape:
			"helper file sources cleanly but does not define scan_staged_secrets (githook_require's guard in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation, same carve-out (§3.9): a present-but-incomplete helper degrades to allow, never to a false block under a wrong cause (§3.2).",
	},
	{
		dependency: "secret-scan-patterns",
		failureShape:
			"pattern rule source unusable for the run — the committed pattern file absent or unreadable at its repo-root-relative home, an up-front pattern-validation failure (format or ERE compile, probed before any path is scanned), or a set empty after stripping comments and blanks (SPEC §3.3's machinery outcome)",
		posture: "open",
		justification:
			"Machinery degradation, none of it the actor's staged input (§3.9's machinery carve-out): the scan disarms for the run with exactly one audit warn record stating it is not enforced (§3.9's degradation-signal rule) — §3.10's valid-AND-non-empty rule makes a scan that checks nothing say so plainly rather than pass as all-clear, and a partial scan over the valid neighbour rows would be a second, weaker predicate (§3.10's lossy-fallback rule).",
	},
	{
		dependency: "secret-scan-measurement",
		failureShape:
			"live scan handed a staged input it cannot measure — a binary path by the numstat no-line-counts outcome, staged content the diff cannot render, or a matcher failure at scan time over one input (SPEC §3.3's unmeasurable-input outcome)",
		posture: "closed",
		justification:
			"Present but cannot measure never vouches (§3.9's measurement rule; the carve-out covers the tier's machinery, not a live predicate's inputs): the staged input is the actor's own and the repair is theirs, the tier's --no-verify escape stands open beneath the refusal, and the refusal carries its own content-free cause distinct from a pattern match (§3.8's refusal-record rule).",
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
