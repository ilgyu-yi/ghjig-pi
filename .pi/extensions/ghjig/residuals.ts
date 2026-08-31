/**
 * Unmodelled bypass vectors, enumerated in place (SPEC §3.11).
 *
 * "A gate enumerates, in place, the bypass vectors it deliberately does
 * not model, so a residual reads as a decision rather than an oversight."
 * This is that enumeration for the protected-branch gate.
 *
 * It is deliberately NOT a second fail-posture inventory (§3.9 keeps that
 * one, and §3.11 forbids a second home for a property). The two tables ask
 * different questions and their key sets are disjoint: the posture
 * inventory says what happens when a dependency the gate USES fails, while
 * this table names paths the gate never sees at all. No entry here carries
 * a posture or a fail direction, because there is no on-miss behaviour to
 * declare — there is no miss, only a vector outside the model.
 *
 * Every entry names where the coverage is homed instead. That is what
 * makes each row a declared deferral: the tiers that bind below the
 * session (§3.2) are indifferent to who or what acted, so a vector this
 * tier cannot see is covered where it is coverable.
 *
 * An entry can also record an instrument this class deliberately does NOT
 * ship, with the surface that carries the concern instead. A declared
 * absence belongs in the same enumeration as every other deferral: an
 * absence a reader has to infer from silence is indistinguishable from an
 * oversight, which is the whole reason this table exists.
 */
export interface ResidualEntry {
	/** The bypass vector, named as a vector rather than as a component. */
	vector: string;
	/** Why it is deliberately outside this gate's model. */
	reason: string;
	/** Where the coverage lives instead. */
	homedAt: string;
}

export const RESIDUALS: readonly ResidualEntry[] = [
	{
		vector: "release-branch-refs",
		reason:
			"This gate derives one protected identity — the branch the repository's own remote pointer names as its default. A release-line ref set is a pattern, not that pointer, and deriving it here would put a second protected-ref rule in a second place.",
		homedAt:
			"§3.3's protected-branch row keeps the release-line refs at tiers 2 and 3, where the rule binds regardless of who acted.",
	},
	{
		vector: "user-typed-bash",
		reason:
			"A command the operator types at the session's own bash surface is out of scope for this gate: that surface's result carries no block field, so the gate has no refusal to return there. Its full-replacement result field is a door, and taking it would put a second execution path for every user command behind this gate — a cost this class has not accepted.",
		homedAt:
			"§3.2's tiers 2 and 3 bind the same git operation whoever issued it; the door stays named here rather than described as unavailable.",
	},
	{
		vector: "non-bash-tool-surfaces",
		reason:
			"Tool surfaces other than the shell can reach a repository, and each one would need its own reading of what it is about to do. This gate reads one surface's command string and says so.",
		homedAt: "§3.2's tiers 2 and 3, which bind at the git and platform layers rather than at a tool surface.",
	},
	{
		vector: "out-of-session-git-writes",
		reason:
			"A git write issued outside the session — another terminal, another tool, a scheduled job — never reaches this tier, which is in-session mistake prevention and not a boundary.",
		homedAt: "§3.2's tiers 2 and 3 are the floor for every actor, including one this session never observes.",
	},
	{
		vector: "git-wrapper-under-another-name",
		reason:
			"The reading recognises the invocation by the literal name `git`, wherever the command word it resolves stands. What stays outside the model is an invocation that never spells that name: an alias, a shell function, a copy or a wrapper script installed under another name executes the same operation while the string names something else, and the reading cannot know what a name on the host resolves to without leaving the string.",
		homedAt: "§3.2's tier 2 binds at the git layer itself, below whatever name invoked it.",
	},
	{
		vector: "unknown-launcher-target",
		reason:
			"A word the reading does not recognise as a launcher — `myrunner git push origin main` — reads as an ordinary program, and a git token after it is one of its arguments. The reading looks past a short list of launchers and no further ON PURPOSE: looking past every unrecognised head refuses `echo git push origin main`, an ordinary command whose git token is data, and that false block is a measured cost this class does not accept (§3.6). The list is a recognition aid for the ceiling; what keeps the floor closed is that a command word the reading cannot resolve at all defaults to a refusal.",
		homedAt:
			"§3.2's tiers 2 and 3 observe the git operation whatever launched it; §3.2 makes the deferral admissible here because this tier is in-session mistake prevention, not a security boundary.",
	},
	{
		vector: "substituted-command-word",
		reason:
			"A command substitution in command-word position — `$(which git) commit` — is a word the reading cannot resolve, so it is refused whenever the command carries a guarded subcommand word; what the substitution's OUTPUT names is never in the string. A substitution carrying no guarded subcommand word is left alone, so the ordinary shell-hook idiom whose whole body is a substitution is not refused for existing, which is the false block §3.6 weighs against. What that leaves outside the model is a guarded subcommand word itself assembled at run time, where the string spells neither the program nor the action.",
		homedAt:
			"§3.2's tiers 2 and 3 observe the git operation whatever produced its name; §3.9's `command-parse` row keeps every form the string DOES fix on the refusing side.",
	},
	{
		vector: "head-advancing-subcommands-outside-commit-push",
		reason:
			"Other subcommands can advance a ref (a merge, a reset, a branch-force, an update-ref). This gate models the two that carry the class's cost, so the modelled set is stated rather than implied by silence.",
		homedAt:
			"§3.2's tier 2 adapters fire on the git operation rather than on the subcommand spelling, and §3.2's tier 3 rules bind the published history.",
	},
	{
		vector: "session-spawned-script",
		reason:
			"A command that names a script runs whatever that script contains, and the reading sees the script's name, not its contents — `./deploy.sh`, `bash deploy.sh`, `source ./env.sh` alike. The discriminator is presence: an interpreter handed its program as TEXT in this string attributes nothing, so a guarded subcommand word anywhere in that command refuses; a name attributes an ordinary program, and treating every named script as unreadable would refuse nearly every command in a working session.",
		homedAt: "§3.2's tiers 2 and 3, which observe the git operation the script eventually performs.",
	},
	{
		vector: "audit-sink-type-check-window",
		reason:
			"The sink's type is examined and then opened, and the entry at that path could change between the two. The examination is a floor for platforms without an atomic no-follow open, not a claim of atomicity.",
		homedAt:
			"§4.6's write-target-equals-read-target rule, carried by the no-follow open where the platform provides it; the state root is owner-only, which is the boundary this window sits inside.",
	},
	{
		vector: "hardlinked-ref-over-block",
		reason:
			"While one file backs two ref names, a write through either name lands on the same bytes, so the gate blocks through both. Once git replaces one of them the link is gone and the names diverge; until then the block is wider than the ref graph alone would suggest.",
		homedAt:
			"Accepted here in the over-block direction: §3.6's cost asymmetry prefers a recoverable false block to a silent wrong allow.",
	},
	{
		vector: "tier2-binds-on-spelling",
		reason:
			"This tier binds on what a ref IS, following symbolic refs and file identity. The adapters below it compare the branch name they are given, so an aliased spelling that this tier catches is not necessarily caught there.",
		homedAt:
			"§3.11 homes the property in one predicate and makes every other surface a call site of it; an adapter that compares a spelling is the gap this row names, and the predicate it must ask is the one here.",
	},
	{
		vector: "in-session-escape-door",
		reason:
			"This class ships no in-session escape, so nothing in a session can turn a block into an allow. An artifact a session can mint is a door the acting party holds the key to, and a name accepting responsibility that the same party could write attests nothing; the correct in-session response to a block is the compliant path the block already names.",
		homedAt:
			"§3.8 places this class's door at the session boundary: an operator who must act against the gate leaves the session and acts through git, where §3.2's tiers 2 and 3 observe the act and hold the record.",
	},
];
