/**
 * Ref-identity matrix for the protected-branch gate (issue #33, AC3/AC5).
 *
 * The property under test is §3.11's first semantics essential: protection
 * binds to what a ref **is**, never to how it is spelled. The suite states
 * that property as a verdict over a guarded command in a real git
 * repository — an aliased, differently-cased, or otherwise re-spelled name
 * for the default branch decides the same way the plain spelling does, and
 * a spelling nothing can resolve refuses instead of approving (§3.9).
 *
 * Two structural rules shape the file:
 *
 *   1. **The instrument is oracled separately.** Every arm rests on a
 *      fixture that must be exactly the git state its name claims — a
 *      symref that really is a symref, a hardlink that really shares an
 *      inode, a packed ref that really has no loose file. The
 *      `gitref-calibration` block asserts each of those against git itself
 *      and touches nothing else, so a red in the matrix is a statement
 *      about the gate and never about the measuring instrument (§3.12).
 *   2. **The gate module is loaded per arm, not at file load.** A static
 *      import would make the calibration block unable to report on the
 *      instrument whenever the gate itself cannot load — the one condition
 *      under which that report is worth most.
 *
 * Every arm is hermetic in both directions: the fixture's git reads a
 * config file the fixture owns and never the host's, `withRepoGitAmbient`
 * extends the same pinning to this process while a verdict is taken, and
 * nothing outside the disposable fixture root is written (§4.7, §5.5).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GateDecision } from "../.pi/extensions/ghjig/gate.ts";
import {
	buildFixture,
	type Fixture,
	type GitRepo,
	type LinkedWorktree,
	removeFixture,
	withRepoGitAmbient,
} from "./harness/run-pi.ts";

/**
 * The contract the arms below assert. A verdict is three-valued: `allow`
 * passes the command through, `block` refuses a measured protected target,
 * and `refuse` withholds approval from a target it could not measure — two
 * distinct failure shapes with two distinct messages (§3.11), and neither
 * of them an approval (§3.9). `arm` names the deciding arm, which is what
 * makes a refusal attributable (§3.8).
 *
 * The decision type is imported from the module that owns it rather than
 * retyped here: a local copy stops matching silently on a rename.
 */
interface GateVerdict {
	decision: GateDecision;
	arm: string;
	message: string;
}
/**
 * `decideCommand` is the gate's composed entry point, so it is homed in
 * `gate.ts`: `command-parse.ts` lexes, `gitref.ts` reads refs, `protected.ts`
 * owns the protected-branch predicate, and composition belongs to none of
 * them. One owning enforcement point per class, every other surface a call
 * site of it (§3.11).
 */
interface GateModule {
	decideCommand(input: { cwd: string; command: string }): GateVerdict;
}

async function loadGate(): Promise<GateModule> {
	return (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
}

/** Takes the gate's verdict on `command` as if it were about to run in `cwd`. */
async function decide(repo: GitRepo, cwd: string, command: string): Promise<GateVerdict> {
	const { decideCommand } = await loadGate();
	return withRepoGitAmbient(repo, () => decideCommand({ cwd, command }));
}

function repoOf(fixture: Fixture): GitRepo {
	const repo = fixture.gitRepo;
	assert.ok(repo !== undefined, "fixture was built without a git repository");
	return repo;
}

const COMMIT = 'git commit -m "docs: a change"';

let aliasFixture: Fixture;
let hardlinkFixture: Fixture;
let caseFixture: Fixture;
let packedFixture: Fixture;
let topicFixture: Fixture;
let worktreeFixture: Fixture;
let ordinaryFixture: Fixture;
let noOriginHeadFixture: Fixture;
let renamedDefaultFixture: Fixture;
let mainAsTopicFixture: Fixture;
let pushUnsetOnTopicFixture: Fixture;
let pushGlobalMatchingFixture: Fixture;
let pushLocalMatchingFixture: Fixture;
let worktreeOnDefault: LinkedWorktree;
let worktreeOnTopic: LinkedWorktree;
let foldsCase: boolean;

const fixtures = (): Fixture[] => [
	aliasFixture,
	hardlinkFixture,
	caseFixture,
	packedFixture,
	topicFixture,
	worktreeFixture,
	ordinaryFixture,
	noOriginHeadFixture,
	renamedDefaultFixture,
	mainAsTopicFixture,
	pushUnsetOnTopicFixture,
	pushGlobalMatchingFixture,
	pushLocalMatchingFixture,
];

before(() => {
	// An ordinary repository: default branch checked out, origin/HEAD present.
	ordinaryFixture = buildFixture({ script: [], gitRepo: {} });

	// `refs/heads/aka` is a symbolic ref at the default branch, and HEAD is at
	// the alias: one ref reached by two names.
	aliasFixture = buildFixture({ script: [], gitRepo: {} });
	const alias = repoOf(aliasFixture);
	alias.addSymrefAlias("refs/heads/aka", `refs/heads/${alias.defaultBranch}`);
	alias.setHead("refs/heads/aka");

	// A second ref whose loose file is a hardlink of the default branch's.
	hardlinkFixture = buildFixture({ script: [], gitRepo: {} });
	const hardlink = repoOf(hardlinkFixture);
	hardlink.addHardlinkedRef("refs/heads/hardlinked", `refs/heads/${hardlink.defaultBranch}`);
	hardlink.setHead("refs/heads/hardlinked");

	// HEAD spelled in a different case than the loose ref it names. The
	// filesystem's case behaviour is probed before HEAD is moved, so the probe
	// never depends on HEAD resolving.
	caseFixture = buildFixture({ script: [], gitRepo: {} });
	const cased = repoOf(caseFixture);
	foldsCase = cased.filesystemFoldsCase();
	cased.setHead(`refs/heads/${cased.defaultBranch.toUpperCase()}`);

	// The same shape with every ref packed away: no loose file remains for any
	// spelling to reach.
	packedFixture = buildFixture({ script: [], gitRepo: {} });
	const packed = repoOf(packedFixture);
	packed.setHead(`refs/heads/${packed.defaultBranch.toUpperCase()}`);
	packed.packRefs();

	// A branch created off the default branch and never committed to: a
	// different ref that happens to hold the same object id.
	topicFixture = buildFixture({ script: [], gitRepo: {} });
	repoOf(topicFixture).switchToNewBranch("topic");

	// Linked worktrees: the primary tree parks on its own branch so the
	// default branch is free to be checked out in a linked worktree.
	worktreeFixture = buildFixture({ script: [], gitRepo: {} });
	const worktree = repoOf(worktreeFixture);
	worktree.switchToNewBranch("parking");
	worktreeOnDefault = worktree.addWorktree("on-default", { checkout: worktree.defaultBranch });
	worktreeOnTopic = worktree.addWorktree("on-topic", { newBranch: "worktree-topic" });

	// The remote's default-branch pointer removed, the remote and its branches
	// left in place: the input the gate cannot measure.
	noOriginHeadFixture = buildFixture({ script: [], gitRepo: {} });
	repoOf(noOriginHeadFixture).removeOriginHead();

	// A repository whose default branch is not called `main`, and where a
	// branch called `main` exists as an ordinary topic branch.
	renamedDefaultFixture = buildFixture({ script: [], gitRepo: { defaultBranch: "trunk" } });
	mainAsTopicFixture = buildFixture({ script: [], gitRepo: { defaultBranch: "trunk", branches: ["main"] } });
	repoOf(mainAsTopicFixture).git(["switch", "-q", "main"]);

	// `push.default` at each configuration layer, on a topic branch.
	pushUnsetOnTopicFixture = buildFixture({ script: [], gitRepo: {} });
	repoOf(pushUnsetOnTopicFixture).switchToNewBranch("topic");
	pushGlobalMatchingFixture = buildFixture({ script: [], gitRepo: { globalPushDefault: "matching" } });
	repoOf(pushGlobalMatchingFixture).switchToNewBranch("topic");
	pushLocalMatchingFixture = buildFixture({ script: [], gitRepo: { localPushDefault: "matching" } });
	repoOf(pushLocalMatchingFixture).switchToNewBranch("topic");
});

after(() => {
	for (const fixture of fixtures()) {
		removeFixture(fixture);
	}
});

describe("gitref-calibration: the fixtures are the git states they claim to be", () => {
	// This block exercises git and the fixture builder only. It is the control
	// that makes every other red in this file attributable: an arm that fails
	// while calibration passes is a statement about the gate.

	it("builds loose-ref-backed repositories (the backend the same-file arms measure)", () => {
		assert.equal(
			repoOf(ordinaryFixture).git(["rev-parse", "--show-ref-format"]),
			"files",
			"the ref-identity arms below read loose ref files; a repository on another ref backend cannot host them",
		);
	});

	it("symref alias: the alias resolves to the default branch", () => {
		const repo = repoOf(aliasFixture);
		assert.equal(repo.git(["symbolic-ref", "refs/heads/aka"]), `refs/heads/${repo.defaultBranch}`);
	});

	it("symref alias: git itself resolves HEAD through the alias to the default branch", () => {
		const repo = repoOf(aliasFixture);
		assert.equal(
			repo.git(["rev-parse", "--symbolic-full-name", "HEAD"]),
			`refs/heads/${repo.defaultBranch}`,
			"the alias and the default branch are one ref by git's own accounting — the fixture states AC3's premise",
		);
	});

	it("hardlinked ref: the two loose ref files share one inode", () => {
		const repo = repoOf(hardlinkFixture);
		const target = statSync(repo.looseRefPath(`refs/heads/${repo.defaultBranch}`));
		const linked = statSync(repo.looseRefPath("refs/heads/hardlinked"));
		assert.ok(
			target.dev === linked.dev && target.ino === linked.ino,
			`expected one inode behind both ref files, got ${target.dev}:${target.ino} and ${linked.dev}:${linked.ino}`,
		);
	});

	it("hardlinked ref: HEAD is on the hardlinked branch, not on the default branch", () => {
		// Without this the block arm downstream could be satisfied by a gate
		// that simply saw the default branch checked out.
		assert.equal(
			repoOf(hardlinkFixture).git(["rev-parse", "--symbolic-full-name", "HEAD"]),
			"refs/heads/hardlinked",
		);
	});

	it("case-variant: HEAD names the upper-cased spelling of the default branch", () => {
		const repo = repoOf(caseFixture);
		assert.equal(
			readFileSync(join(repo.gitDir, "HEAD"), "utf8").trim(),
			`ref: refs/heads/${repo.defaultBranch.toUpperCase()}`,
		);
	});

	it("case-variant: the case probe agrees with what this filesystem does to a real ref", () => {
		// The probe writes and removes its own ref; this asserts its verdict
		// against the default branch's actual visibility under an upper-cased
		// path, so the conditioned arm below is conditioned on a measurement.
		const repo = repoOf(caseFixture);
		assert.equal(existsSync(repo.looseRefPath(`refs/heads/${repo.defaultBranch.toUpperCase()}`)), foldsCase);
	});

	it("packed: the default branch keeps no loose ref file", () => {
		const repo = repoOf(packedFixture);
		assert.equal(existsSync(repo.looseRefPath(`refs/heads/${repo.defaultBranch}`)), false);
	});

	it("packed: the default branch still resolves under its own spelling", () => {
		// Packing must leave a working repository — otherwise the refusal
		// downstream would be about a broken fixture, not about the spelling.
		const repo = repoOf(packedFixture);
		assert.equal(repo.tryGit(["rev-parse", `refs/heads/${repo.defaultBranch}`]).ok, true);
	});

	it("packed: the upper-cased spelling resolves for nobody", () => {
		const repo = repoOf(packedFixture);
		assert.equal(repo.tryGit(["rev-parse", repo.defaultBranch.toUpperCase()]).ok, false);
	});

	it("fresh topic branch: shares an object id with the default branch", () => {
		// The reason no ref-identity leg can be built on object-id equality: a
		// legitimate topic branch is object-identical to the branch it was cut
		// from until its first commit, and it must pass.
		const repo = repoOf(topicFixture);
		assert.equal(repo.git(["rev-parse", "refs/heads/topic"]), repo.git(["rev-parse", `refs/heads/${repo.defaultBranch}`]));
	});

	it("linked worktree: the per-worktree gitdir holds no refs of its own", () => {
		assert.deepEqual(readdirSync(join(worktreeOnDefault.gitDir, "refs")), []);
	});

	it("linked worktree: commondir points at the primary gitdir where the refs live", () => {
		const repo = repoOf(worktreeFixture);
		const commondir = readFileSync(join(worktreeOnDefault.gitDir, "commondir"), "utf8").trim();
		assert.equal(realpathSync(resolve(worktreeOnDefault.gitDir, commondir)), realpathSync(repo.gitDir));
	});

	it("linked worktree: each worktree's HEAD is its own", () => {
		const repo = repoOf(worktreeFixture);
		assert.deepEqual(
			[
				repo.git(["rev-parse", "--symbolic-full-name", "HEAD"], worktreeOnDefault.root),
				repo.git(["rev-parse", "--symbolic-full-name", "HEAD"], worktreeOnTopic.root),
			],
			[`refs/heads/${repo.defaultBranch}`, "refs/heads/worktree-topic"],
		);
	});

	it("ordinary repository: has no commondir file", () => {
		// Absence is the healthy default, present in every ordinary clone —
		// which is why the gate below must not read a missing commondir as a
		// reason to withhold a verdict.
		assert.equal(existsSync(join(repoOf(ordinaryFixture).gitDir, "commondir")), false);
	});

	it("ordinary repository: origin/HEAD names the default branch", () => {
		const repo = repoOf(ordinaryFixture);
		assert.equal(repo.git(["symbolic-ref", "refs/remotes/origin/HEAD"]), `refs/remotes/origin/${repo.defaultBranch}`);
	});

	it("origin/HEAD removed: the symref is gone", () => {
		assert.equal(repoOf(noOriginHeadFixture).tryGit(["symbolic-ref", "refs/remotes/origin/HEAD"]).ok, false);
	});

	it("origin/HEAD removed: the remote's default branch itself is still there", () => {
		// The loss is exactly one pointer — so a degradation wider than that
		// pointer is a defect of the gate, not of the fixture (§3.9).
		const repo = repoOf(noOriginHeadFixture);
		assert.equal(repo.tryGit(["rev-parse", `refs/remotes/origin/${repo.defaultBranch}`]).ok, true);
	});

	it("renamed default branch: origin/HEAD names it, and a branch called main is an ordinary branch", () => {
		assert.deepEqual(
			[
				repoOf(renamedDefaultFixture).git(["symbolic-ref", "refs/remotes/origin/HEAD"]),
				repoOf(mainAsTopicFixture).git(["rev-parse", "--symbolic-full-name", "HEAD"]),
			],
			["refs/remotes/origin/trunk", "refs/heads/main"],
		);
	});

	it("push.default: unset in the repository built without one", () => {
		assert.equal(repoOf(pushUnsetOnTopicFixture).tryGit(["config", "--get", "push.default"]).ok, false);
	});

	it("push.default: the local layer holds what the fixture wrote", () => {
		assert.equal(repoOf(pushLocalMatchingFixture).git(["config", "--local", "--get", "push.default"]), "matching");
	});

	it("push.default: the global layer holds what the fixture wrote", () => {
		assert.equal(repoOf(pushGlobalMatchingFixture).git(["config", "--global", "--get", "push.default"]), "matching");
	});

	it("push.default: the fixture's global config reaches a git run under this process's ambient environment", () => {
		// Positive control for the channel the global-precedence arm depends
		// on. The gate resolves git state in-process, so unless this holds the
		// arm below would be measuring an empty configuration and would pass
		// for the wrong reason.
		const repo = repoOf(pushGlobalMatchingFixture);
		const seen = withRepoGitAmbient(repo, () =>
			execFileSync("git", ["config", "--get", "push.default"], {
				cwd: repo.root,
				env: process.env,
				encoding: "utf8",
			}).trim(),
		);
		assert.equal(seen, "matching");
	});
});

describe("AC3: protection binds to what the ref is, not how it is spelled (§3.11)", () => {
	it("symref alias: a commit on an alias of the default branch is blocked", async () => {
		const repo = repoOf(aliasFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("hardlinked ref: a commit on a ref hardlinked to the default branch's file is blocked", async () => {
		// This arm is NOT a ref-identity assertion, and must not be read as
		// one. Git does not consider a hardlinked pair one ref: it writes
		// `<ref>.lock` and renames over it, so the first write to either ref
		// breaks the link and the two diverge — a shared inode is a transient
		// storage coincidence, verified as such against git (`symbolic-ref`
		// reports the hardlinked ref is not a symbolic ref, and both names
		// appear as separate branches). What the arm pins is the composed
		// verdict of the gate's same-file leg: while one file backs both
		// names, a commit through either name lands on the same bytes, so the
		// gate blocks. It is the portable kill for the mutant that deletes
		// that leg — portable because it needs no case-folding filesystem.
		const repo = repoOf(hardlinkFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("case-variant: a commit on a differently-cased spelling of the default branch is blocked", async (t) => {
		if (!foldsCase) {
			// A deliberate branch that says what it is, never a silent
			// fall-through (§5.3): on a case-sensitive filesystem the two
			// spellings are two different refs and there is nothing here to
			// measure. AC3 does not rest on this arm — the symref-alias and
			// hardlink arms carry it on every filesystem.
			t.skip("filesystem does not fold case: refs/heads/MAIN and refs/heads/main are distinct refs here");
			return;
		}
		const repo = repoOf(caseFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("packed + upper-cased HEAD: a target no leg can resolve is never approved", async () => {
		// With every ref packed, neither the resolved-name leg nor the
		// same-file leg has anything to read. That `git rev-parse MAIN` fails
		// here too is not a licence to allow: an input the gate cannot measure
		// is refused, never approved (§3.9). The assertion is therefore on the
		// absence of approval, not on which non-approving arm fires.
		const repo = repoOf(packedFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("renamed default branch: a commit on it is blocked though it is not called main", async () => {
		// The protected ref is the one the repository says is its default, read
		// from origin/HEAD — never a name carried in the gate's own text.
		const repo = repoOf(renamedDefaultFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("renamed default branch: a commit on a branch called main is allowed there", async () => {
		// The other half of the same property, and the false-block arm for it:
		// where `main` is an ordinary topic branch, it passes.
		const repo = repoOf(mainAsTopicFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("fresh topic branch: a commit on an object-identical topic branch is allowed", async () => {
		// The false-block arm of AC3: the topic branch holds the same object
		// id as the default branch (asserted in calibration), and it passes.
		const repo = repoOf(topicFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("AC3: ref lookup follows the repository layout, not a fixed path (§3.11)", () => {
	it("linked worktree: a commit on the worktree's own topic branch is allowed", async () => {
		// A gate that read `<gitdir>/refs` would find that directory empty in
		// a linked worktree and could reach any verdict it liked; refs live at
		// the common dir while HEAD is per-worktree.
		const repo = repoOf(worktreeFixture);
		const verdict = await decide(repo, worktreeOnTopic.root, COMMIT);
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("linked worktree: a commit on the default branch checked out in a worktree is blocked", async () => {
		const repo = repoOf(worktreeFixture);
		const verdict = await decide(repo, worktreeOnDefault.root, COMMIT);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("ordinary repository: a missing commondir is the healthy default and decides normally", async () => {
		// Every ordinary clone lacks a commondir file (asserted in
		// calibration). A gate keyed on "commondir missing ⇒ cannot measure"
		// would withhold a verdict in every ordinary clone; this pins that it
		// decides.
		const repo = repoOf(ordinaryFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("AC5: an unmeasurable default branch refuses, and no wider (§3.9)", () => {
	it("origin/HEAD absent: a guarded commit is not approved", async () => {
		const repo = repoOf(noOriginHeadFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("origin/HEAD absent: the refusal names the command that restores the pointer", async () => {
		// §3.11 arm-scoped remediation: the recovery named must be live at the
		// surface that emits it.
		const repo = repoOf(noOriginHeadFixture);
		const verdict = await decide(repo, repo.root, COMMIT);
		assert.match(verdict.message, /git remote set-head origin --auto/, `verdict: ${JSON.stringify(verdict)}`);
	});

	it("origin/HEAD absent: a command that lands on no ref is unaffected", async () => {
		// The degradation refuses only the inputs it would mis-measure; an
		// unguarded command was never one of them (§3.9).
		const repo = repoOf(noOriginHeadFixture);
		const verdict = await decide(repo, repo.root, "echo hello");
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("AC3: a bare push resolves its target through push.default (§3.11)", () => {
	it("unset push.default on the default branch: blocked", async () => {
		// git's built-in default is `simple`, which pushes the current branch.
		const repo = repoOf(ordinaryFixture);
		const verdict = await decide(repo, repo.root, "git push");
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("unset push.default on a topic branch: allowed", async () => {
		const repo = repoOf(pushUnsetOnTopicFixture);
		const verdict = await decide(repo, repo.root, "git push");
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("push.default = matching in the repository's own config: not approved from a topic branch", async () => {
		// `matching` pushes every branch that exists on both ends, the default
		// branch among them, so the current branch is not the target set.
		const repo = repoOf(pushLocalMatchingFixture);
		const verdict = await decide(repo, repo.root, "git push");
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("push.default = matching in the global config: not approved from a topic branch", async () => {
		// The wrong-allow direction: a reader that consults only the
		// repository's own config sees nothing here, resolves to `simple`, and
		// approves a command that would push the default branch.
		const repo = repoOf(pushGlobalMatchingFixture);
		const verdict = await decide(repo, repo.root, "git push");
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});
