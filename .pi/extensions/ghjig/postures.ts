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
		dependency: "local-tier-derivation",
		failureShape:
			"the repository top is unresolvable, so neither the record sink nor the containment test below can be formed at all (.githooks/_lib.sh's prelude)",
		posture: "open",
		justification:
			"Clone-shape state the acting party's git operation did not cause and cannot repair from inside a block (§3.9's machinery carve-out); the advice tier no-ops rather than wedging git (§3.2).",
	},
	{
		dependency: "local-tier-derivation",
		failureShape:
			"the repository top discovered from the running adapter's own installed position is not the top of the repository the operation runs against (.githooks/_lib.sh's prelude)",
		posture: "open",
		justification:
			"A tier that resolved its checks outside the repository it was invoked in would write its records there too, across the boundary §5.5 draws, so it runs no check and says so on stderr (§3.9's degradation-signal rule). No record is owed and none is written: the only sink this run could reach is the one the refusal exists to keep it out of. The comparison binds the ADAPTER position alone: the helper directory is appended to that position afterwards and is neither resolved nor re-tested, so a `helpers` component linked out of the repository is sourced with no refusal — enumerated in place as a residual (§3.11), not closed here.",
	},
	{
		dependency: "local-tier-derivation",
		failureShape:
			"no adapter runs at all — under the relative core.hooksPath the bind instrument writes, an operation git resolves against a caller-named work tree finds no hooks directory there (.githooks/bind_local_tier.sh's activation, measured through `GIT_WORK_TREE=<other dir> git commit`)",
		posture: "open",
		justification:
			"Not a posture the tier chooses: no adapter is executed, so the prelude's refusal never runs and no surface of this tier speaks — measured, a staged pattern-matching key commits with zero bytes on either stream and no record. No other row on this dependency covers this shape. It is enumerated here rather than closed: the relative spelling is what lets a linked worktree arm itself from its own top, and no check that lives inside a hook can reach a shape in which no hook runs (SPEC §3.8's argv-invisible members, §3.11).",
	},
	{
		dependency: "local-tier-derivation",
		failureShape:
			"the running adapter's own installed position is unresolvable, so the helper directory cannot be derived (.githooks/_lib.sh's prelude)",
		posture: "open",
		justification:
			"Enforcement-chain degradation on §3.9's absent-dependency side: an adapter that cannot locate itself was never installed here in a form the tier can use, and the acting party cannot repair that from inside a block; the advice tier no-ops rather than wedging git (§3.2).",
	},
	{
		dependency: "local-tier-derivation",
		failureShape:
			"the prelude itself is absent — an adapter runs, but `.githooks/_lib.sh` is not beside it, so `githook_source` is undefined and every delegated arm folds (each of the three adapters sources it as its first executable statement)",
		posture: "open",
		justification:
			"Enforcement-chain degradation on §3.9's absent-dependency side: absent means never installed here, which the acting party's git operation did not cause and cannot repair from inside a block. Measured on an armed clone with `_lib.sh` unlinked, committing a staged pattern-matching key under an invalid subject: the commit exits 0, both reach HEAD, the audit line count is unchanged, and the classifier answers `bound`, so session start is silent too; the only trace is the shell's own 'No such file or directory' on stderr, which is no surface of this tier. Enumerated rather than closed, and the residual is in place: this tier's record writer and every degradation line it prints live in the absent file, so a shell that failed to source it can emit neither, and the closure check the sibling rows rest on reads that file's INTERIOR and by construction cannot reach its absence.",
	},
	{
		dependency: "local-tier-exclusion",
		failureShape:
			"the resolved info/exclude path, or the directory component the run would create, is a symbolic link or an existing non-regular object (.githooks/bind_local_tier.sh's exclusion fallback)",
		posture: "closed",
		justification:
			"`mkdir -p` and `>>` both follow a link, so the append would land wherever that object points while the run reported a verified bound state — the write-through-link refusal §5.5 binds on every record producer, asked here of the components this writer creates and not of the ones above them. The run refuses without writing and names the object and the remedy; its false-block cost is nil in the shape the fallback exists for (§3.6's obligation (i)) — an ABSENT exclude file is still created and appended.",
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
		dependency: "commit-format-helper",
		failureShape:
			"conventional_commit.sh present but its source does not complete — it exits while being sourced, fails to parse, or returns a non-zero status (githook_source's EXIT-trap fold and safe_source's non-zero-return record in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation, same carve-out (§3.9): a source that does not hand control back cleanly is machinery, not the actor's input; `exit` inside a sourced helper terminates the hook shell itself and would carry its status out to git, so the fold turns that into an allow for this arm and every arm after it (§3.2's arm ordering). The fold is not silent: one stderr line plus exactly one warn record naming the helper (§3.9's degradation-signal rule). What the fold COVERS (§3.11) is a helper's own error path that ends in `exit` or in a non-zero return, with the tier's EXIT slot and its source-depth counter untouched and the shell alive — the terms it runs on, not exceptions to a wider claim, since a sourced file executes in the hook's own shell and can reach any of them. Outside those terms the outcome is not this tier's to decide and the fold's line and record may not run — measured on a sourced helper, `trap ':' EXIT; exit 5` refuses the commit and `trap 'exit 0' EXIT; exit 5` creates it, both with no tier bytes on either stream and no record — so in the allow direction this tier's surfaces carry exactly what an enforced pass carries.",
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
		dependency: "branch-guard-helper",
		failureShape:
			"branch_guard.sh present but its source does not complete — it exits while being sourced, fails to parse, or returns a non-zero status (githook_source's EXIT-trap fold and safe_source's non-zero-return record in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation, same carve-out (§3.9): a source that does not hand control back cleanly is machinery, not the actor's input; the fold turns that into an allow for this arm and every arm after it (§3.2's arm ordering), with one stderr line plus exactly one warn record naming the helper (§3.9's degradation-signal rule). The scope condition stated on the commit-format-helper source row — and what holds outside its terms — holds here too.",
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
		dependency: "secret-scan-helper",
		failureShape:
			"secret_scan.sh present but its source does not complete — it exits while being sourced, fails to parse, or returns a non-zero status (githook_source's EXIT-trap fold and safe_source's non-zero-return record in .githooks/_lib.sh)",
		posture: "open",
		justification:
			"Enforcement-chain degradation, same carve-out (§3.9): a source that does not hand control back cleanly is machinery, not the actor's input; the fold turns that into an allow for this arm and every arm after it (§3.2's arm ordering), with one stderr line plus exactly one warn record naming the helper (§3.9's degradation-signal rule). The scope condition stated on the commit-format-helper source row — and what holds outside its terms — holds here too.",
	},
	{
		dependency: "secret-scan-patterns",
		failureShape:
			"pattern rule source unusable for the run — the committed pattern file absent or unreadable beside the helper that reads it, an up-front pattern-validation failure (format or ERE compile, probed before any path is scanned), or a set empty after stripping comments and blanks (SPEC §3.3's machinery outcome)",
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
