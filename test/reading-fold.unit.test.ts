/**
 * Which way the reading folds when it does not understand a command
 * (issue #33, AC1, AC2, AC5; §3.6, §3.9, §3.11).
 *
 * `command-reading.unit.test.ts` pins the SHAPES the reading has been taught.
 * This file pins the DIRECTION it folds in when it has been taught nothing.
 * The two are different contracts, and only the second one terminates:
 * enumerating shapes is a walk with no last step, because every ordinary
 * session spells the same guarded action a way nobody wrote down.
 *
 * The invariant:
 *
 *   > The reading answers `none` only where it can account for every segment
 *   > of the command — where it has resolved what each one runs and that none
 *   > of them advances a ref. A segment it cannot account for leaves the
 *   > reading undecidable, and the gate refuses it.
 *
 * `none` is an AFFIRMATIVE claim — "this command lands on no ref" — and the
 * gate converts it into `allow / not-a-git-command`. A reading that returns
 * `none` for a string it did not understand has therefore approved a command
 * on the strength of a measurement that never happened, which is exactly the
 * fold §3.9 forbids. Under the invariant above, the unrecognised case lands
 * on `undecidable` instead, and the actor is told the target could not be
 * read rather than being let through in silence.
 *
 * The standing cost this fold buys, stated here because it is what makes the
 * ceiling block below load-bearing rather than decorative: this class ships
 * NO IN-SESSION ESCAPE (§3.8 — the door is the session boundary,
 * `in-session-escape-door` in `residuals.ts`). A false block costs a trip
 * outside the session. So the ceiling is not a courtesy to ordinary work; it
 * is the other half of the same contract, and a repair that closes the floor
 * by refusing a working session has not satisfied it.
 *
 * Floor arms come in the two strengths `command-reading.unit.test.ts`
 * established, decided by one question — does the reading resolve THIS
 * command's target?
 *
 *   - the string still fixes the target (a literal `git`, a spelled-out
 *     subcommand, a spelled-out ref), so the only admissible outcome is the
 *     plain spelling's: a block that carries the recovery;
 *   - the string does not fix it (the program is assembled, the repository
 *     moves, an interpreter is handed text under flags the reading does not
 *     model), so approval is withheld and no outcome beyond that is this
 *     file's to state.
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	type GitRepo,
	type LinkedWorktree,
	removeFixture,
	withRepoGitAmbient,
} from "./harness/run-pi.ts";

type ParsedCommand =
	| { kind: "none" }
	| { kind: "target"; action: "commit" | "push"; refSpec: string | null }
	| { kind: "undecidable"; why: string };

interface CommandParseModule {
	parseGitCommand(command: string): ParsedCommand;
}
interface GateVerdict {
	decision: "allow" | "block" | "refuse";
	arm: string;
	message: string;
}
interface GateModule {
	decideCommand(input: { cwd: string; command: string }): GateVerdict;
	/** The affordance a block names as its next step, as the runtime spells it. */
	AFFORDANCE_COMMAND: string;
}

/**
 * A session sitting ON the repository's default branch. Every arm whose
 * subject is the command string alone is taken here, so a non-approval comes
 * from the form under test and not from the branch.
 */
let atTheDefaultBranch: Fixture;
let defaultBranchRepo: GitRepo;

/**
 * A session sitting on a TOPIC branch, with a linked worktree of the same
 * repository checked out on the default branch.
 *
 * This is the only arrangement in which a directory change is the whole of
 * the difference: the command the session would run here is allowed, the
 * identical command run one directory over is blocked, and the two
 * directories share one ref store, so nothing but the `cd` separates them.
 */
let besideAWorktree: Fixture;
let topicRepo: GitRepo;
let defaultBranchWorktree: LinkedWorktree;

before(() => {
	atTheDefaultBranch = buildFixture({ script: [], gitRepo: {} });
	const plain = atTheDefaultBranch.gitRepo;
	assert.ok(plain !== undefined, "fixture was built without a git repository");
	defaultBranchRepo = plain;

	besideAWorktree = buildFixture({ script: [], gitRepo: {} });
	const beside = besideAWorktree.gitRepo;
	assert.ok(beside !== undefined, "fixture was built without a git repository");
	topicRepo = beside;
	topicRepo.switchToNewBranch("topic");
	defaultBranchWorktree = topicRepo.addWorktree("sibling", { checkout: topicRepo.defaultBranch });
});

after(() => {
	removeFixture(atTheDefaultBranch);
	removeFixture(besideAWorktree);
});

/**
 * The composed verdict for `command`, taken in `cwd`.
 *
 * The git ambient of this process is pinned to the fixture's own
 * configuration for the duration, so no property of a verdict is inherited
 * from the host (§3.12).
 */
async function decideIn(repo: GitRepo, cwd: string, command: string): Promise<GateVerdict> {
	const { decideCommand } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
	return withRepoGitAmbient(repo, () => decideCommand({ cwd, command }));
}

/** The verdict a session sitting on the default branch gets for `command`. */
function decide(command: string): Promise<GateVerdict> {
	return decideIn(defaultBranchRepo, defaultBranchRepo.root, command);
}

/** The verdict the session beside the worktree gets for `command`. */
function decideBesideTheWorktree(command: string): Promise<GateVerdict> {
	return decideIn(topicRepo, topicRepo.root, command);
}

async function parse(command: string): Promise<ParsedCommand> {
	const { parseGitCommand } = (await import(
		"../.pi/extensions/ghjig/command-parse.ts"
	)) as unknown as CommandParseModule;
	return parseGitCommand(command);
}

/** True when the verdict lets the command through — the only outcome a floor forbids. */
function approves(verdict: GateVerdict): boolean {
	return verdict.decision === "allow";
}

/**
 * True when the verdict's message names the in-flow authoring affordance
 * §3.11 requires every enforced gate to owe.
 *
 * The name comes from the runtime's own export, never from a spelling
 * restated here: a rename moves the arms with it instead of leaving a
 * literal that still matches nothing and an arm that still passes.
 */
async function namesTheAffordance(verdict: GateVerdict): Promise<boolean> {
	const { AFFORDANCE_COMMAND } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
	return verdict.message.includes(AFFORDANCE_COMMAND);
}

/**
 * What a real POSIX shell resolves `probe` to, run inside `repo`.
 *
 * Used only to establish a premise — that a word this file claims a shell
 * turns into `git` really is turned into `git`. The shell runs with the
 * fixture's own git environment, so nothing it reports comes from the host's
 * configuration or identity (§3.12), and every probe is a read.
 */
function resolvedByARealShell(repo: GitRepo, probe: string): string {
	return execFileSync("sh", ["-c", probe], { cwd: repo.root, env: repo.env, encoding: "utf8" }).trim();
}

describe("calibration: both fixtures are repositories this gate governs and decides in", () => {
	it("the plainest guarded action at the default branch is blocked", async () => {
		// Every floor arm below reads a non-approval and every ceiling arm reads
		// an approval; both are satisfied by a gate that never governed this
		// repository. This arm is what distinguishes the reading's verdicts from
		// an absence of scope (§3.12).
		const verdict = await decide('git commit -m "docs: the plainest spelling"');
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("and beside the worktree, the session's own directory is one the gate allows", async () => {
		// The premise of every directory-change arm: WITHOUT the `cd` this exact
		// command is approved, so a non-approval there is attributable to the
		// directory change and to nothing else.
		const verdict = await decideBesideTheWorktree("git commit -m x");
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("while the directory one `cd` away is one the gate blocks", async () => {
		// The other half of that premise, read at the destination itself: the
		// effect each prefixed form achieves is an effect this gate blocks when
		// it is asked about it directly.
		const verdict = await decideIn(topicRepo, defaultBranchWorktree.root, "git commit -m x");
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("and real git agrees the two directories are on different branches", () => {
		// Read out of git rather than out of the harness's own bookkeeping: the
		// arrangement is only a reproduction if git itself reports it.
		assert.deepEqual(
			{
				session: topicRepo.git(["rev-parse", "--abbrev-ref", "HEAD"]),
				worktree: topicRepo.git(["rev-parse", "--abbrev-ref", "HEAD"], defaultBranchWorktree.root),
			},
			{ session: "topic", worktree: topicRepo.defaultBranch },
		);
	});
});

describe("a segment the reading cannot account for is not approved — the target is still fixed (§3.9)", () => {
	/**
	 * A line continuation is whitespace. The shell removes the backslash and
	 * the newline before a word is formed, so each of these strings IS the
	 * plain spelling: a literal `git`, a spelled-out subcommand, a spelled-out
	 * ref. The string fixes the target exactly as the one-line form does, so
	 * the only admissible outcome is the one-line form's — a block that
	 * carries the recovery. A refusal would be right about non-approval and
	 * wrong about everything the actor is told.
	 */
	const stillFixesTheTarget = [
		"git \\\n  push origin main",
		"git \\\n\tcommit -m x",
		"git \\\n  commit -m x",
	];

	for (const command of stillFixesTheTarget) {
		it(`a continuation between the command word and its subcommand: ${JSON.stringify(command)}`, async () => {
			const verdict = await decide(command);
			assert.deepEqual(
				{ decision: verdict.decision, namesTheAffordance: await namesTheAffordance(verdict) },
				{ decision: "block", namesTheAffordance: true },
				`verdict: ${JSON.stringify(verdict)}`,
			);
		});
	}
});

describe("a segment the reading cannot account for is not approved — approval is withheld and no more (§3.9)", () => {
	/**
	 * Every form here runs the same guarded action the plain spelling runs.
	 * None of them lets the reading fix the target: an interpreter carrying
	 * flags whose meaning decides what its argument IS, or a command word the
	 * shell assembles before anything is executed. What each one owes the
	 * floor is that the command is not approved; which non-approving outcome
	 * lands is a property with a home of its own (§3.11).
	 */
	const approvalIsWithheldAndNoMore: Record<string, string[]> = {
		"an interpreter whose program-text flag is bundled with others": [
			'bash -lc "git push origin main"',
			'bash -ec "git push origin main"',
			'sh -xc "git commit -m x"',
			'zsh -ic "git push origin main"',
		],
		"an interpreter whose program-text flag is quoted": ['bash "-c" "git commit -m x"'],
		// The interpreter named by path is the same interpreter: the shell
		// executes the last component of the word, so a reading keyed on the
		// spelling answers about the path rather than about the program. The
		// literal here is a string being READ; the suite opens no such path.
		"an interpreter named by path": ['/bin/bash -lc "git push origin main"'],
		"a command word the shell assembles by parameter expansion": [
			"${GIT} push origin main",
			"${GIT} commit -m x",
		],
	};

	for (const [position, commands] of Object.entries(approvalIsWithheldAndNoMore)) {
		for (const command of commands) {
			it(`${position}: ${command}`, async () => {
				const verdict = await decide(command);
				assert.equal(approves(verdict), false, `verdict: ${JSON.stringify(verdict)}`);
			});
		}
	}
});

describe("a directory change the reading cannot account for is not approved (§3.9)", () => {
	/**
	 * A bare `cd` is already read: the action's repository is not the one the
	 * verdict was taken against, so the command refuses. The forms below reach
	 * the identical effect with a word in front of the `cd` — a builtin
	 * qualifier, a command qualifier, an interpreter handed the same text, an
	 * escape that suppresses alias lookup. Each of them moves the shell's
	 * working directory before the guarded action runs, so the repository the
	 * verdict was taken against is not the repository the action lands in.
	 *
	 * The calibration block above establishes both ends: the session's own
	 * directory is one this gate ALLOWS the command in, and the destination is
	 * one it BLOCKS the command in. A form that is approved here is therefore
	 * a verdict taken about a directory the command left.
	 */
	const prefixedDirectoryChanges: Record<string, string> = {
		"a builtin qualifier": "builtin ",
		"a command qualifier": "command ",
		"an interpreter handed the change as text": "eval ",
		"an escape that suppresses alias lookup": "\\",
	};

	for (const [described, prefix] of Object.entries(prefixedDirectoryChanges)) {
		it(`${described}: ${prefix}cd <worktree> && git commit -m x`, async () => {
			const command = `${prefix}cd ${defaultBranchWorktree.root} && git commit -m x`;
			const verdict = await decideBesideTheWorktree(command);
			assert.equal(approves(verdict), false, `verdict: ${JSON.stringify(verdict)}`);
		});
	}
});

describe("the fold's direction, pinned as a direction rather than as a list of shapes (§3.9)", () => {
	/**
	 * THE ARM THIS FILE EXISTS FOR.
	 *
	 * `gi$(:)t` is a command word the shell assembles by splicing a
	 * substitution through the middle of it. It is deliberately synthetic: no
	 * working session emits it, and it is none of the shapes any other arm in
	 * this repository names. That is the whole point — it stands for THE NEXT
	 * UNKNOWN SHAPE, the one nobody has written an arm for yet.
	 *
	 * Its only property is the one the invariant is about: the reading cannot
	 * account for what this segment runs. Under the fold this file pins, that
	 * is enough to withhold approval, and no rule about this particular
	 * spelling is needed to get there.
	 *
	 * DO NOT DELETE THIS ARM AS REDUNDANT WITH A SIBLING. Every other arm here
	 * names a shape, and a reading repaired shape by shape passes all of them
	 * while still folding the unrecognised case to `none`. This arm is the
	 * only one that reds if the fold direction is ever restored — it is the
	 * regression guard for the decision itself, not for any instance of it.
	 */
	const AN_UNTAUGHT_COMMAND_WORD = "gi$(:)t commit -m x";

	it("calibration — a real shell resolves that word to git", () => {
		// The premise, taken from a shell rather than asserted: without it the
		// arm below could be refusing a string that runs nothing at all.
		assert.equal(
			resolvedByARealShell(defaultBranchRepo, "gi$(:)t rev-parse --abbrev-ref HEAD"),
			defaultBranchRepo.defaultBranch,
		);
	});

	it("a construct the reading was never taught withholds approval by default", async () => {
		const verdict = await decide(AN_UNTAUGHT_COMMAND_WORD);
		assert.equal(approves(verdict), false, `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("the ceiling: the working session this fold has to keep affording (§3.6)", () => {
	/**
	 * The whole cost of inverting the fold, and the reason it is stated beside
	 * the floor rather than in a file of its own. There is no in-session
	 * escape from this class, so each of these commands is one an actor cannot
	 * talk its way past — a refusal here is a trip outside the session, for a
	 * command that advances no protected ref.
	 *
	 * These are the shapes a session emits all day: builds, listings, loops,
	 * conditionals, scripts named rather than quoted, and a git token that is
	 * DATA rather than a command word.
	 */
	const carryingNoGuardedAction = [
		"npm test",
		"ls -la",
		"for f in *.txt; do echo $f; done",
		"if true; then echo hi; fi",
		"./deploy.sh",
		// The declared script residual: the interpreter is named, the program
		// text is not in the string (`session-spawned-script`, §3.2, §3.11).
		"bash deploy.sh",
		"sh ./scripts/build.sh",
		// A git token in ARGUMENT position, never in command position.
		'echo "git push origin main"',
		'grep -r "git push origin main" .',
		// A program that is not git, whose own subcommand happens to be spelled
		// like a guarded one.
		"docker push myimage",
		// Unguarded git subcommands: reading the repository, not advancing it.
		"git status",
		"git log --oneline -5",
		"git diff --stat",
		"git switch -c topic",
		"git stash push -m wip",
		// A directory change carrying no guarded action changes nothing this
		// gate measures, so it is not refused for existing.
		"mkdir -p a/b && cd a/b && ls",
	];

	for (const command of carryingNoGuardedAction) {
		it(`${command} is allowed`, async () => {
			const verdict = await decide(command);
			assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
		});
	}

	it("a separator inside a quoted message is data, so the action stays decided", async () => {
		// The other edge of the same fold. Reading the quoted `;` and `cd` as
		// structure would turn a decidable commit into a refusal — non-approval
		// for a cause the command does not have. The ceiling here is that the
		// verdict is the plain spelling's, not that it is permissive.
		const verdict = await decide('git commit -m "fix; cd /tmp"');
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("a hash inside a word still names the destination it spells", async () => {
		// Asserted on the reading rather than on the verdict, because the
		// property IS the parse: a destination the reading must still name. The
		// gate's own answer about a branch that does not exist is a different
		// property with a different home.
		assert.deepEqual(await parse("git push origin ma#in"), {
			kind: "target",
			action: "push",
			refSpec: "ma#in",
		});
	});
});
