/**
 * What the reading does with the words AROUND the guarded action (issue #33,
 * AC1, AC2, AC5; §3.9, §3.11).
 *
 * The gate's reading is three-valued, and the whole safety of the third
 * value depends on where a guarded action can hide. A shell command word is
 * not the first token of a string: an assignment prefix, a redirection, a
 * compound-statement keyword, a wrapper, an expansion, or an interpreter
 * handed the program text can all occupy that position while the action that
 * advances a ref runs anyway. Every such form that folds to "this command
 * lands on no ref" is an affirmative allow derived from a reading that never
 * happened, which is precisely the fold §3.9 forbids.
 *
 * Two ends, always pinned together:
 *
 *   - the **floor** — forms carrying a guarded action must not be approved;
 *   - the **ceiling** — forms carrying none must not be refused.
 *
 * They are one contract, because every widening of the floor is a candidate
 * false block and every relief of the ceiling is a candidate wrong allow
 * (§3.6's cost asymmetry decides the direction, not the convenience of a
 * single arm). A change that satisfies one end alone has not satisfied the
 * contract, so the two ends are stated side by side and never in separate
 * files.
 *
 * The floor is asserted on the COMPOSED verdict rather than on the reading's
 * own value: what matters to an operator is that the command is not
 * approved, and a reading that refuses while the gate treats the refusal as
 * "nothing to check" is the same silent wrong allow with an extra step.
 * Non-approval is the floor's minimum and not the whole of it: where the
 * prefix stands in front of a target the string still fixes, the arm reads
 * the block and the recovery it carries, because "not approved" alone cannot
 * tell a named branch from a command the gate says it could not read. The
 * ceiling is asserted the same way wherever the composed verdict is the
 * point, and on the reading itself where the property IS the parse — a
 * destination the reading must still name.
 *
 * The fixture repository sits on its own default branch, so a floor arm's
 * non-approval comes from the form under test rather than from the branch;
 * the calibration block below is what keeps that premise honest.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ParsedCommand } from "../.pi/extensions/ghjig/command-parse.ts";
import { buildFixture, type Fixture, type GitRepo, removeFixture, withRepoGitAmbient } from "./harness/run-pi.ts";

/**
 * The reading's own type, taken from the module that owns it: a local copy
 * of a runtime type stops matching silently on a rename.
 */
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

let fixture: Fixture;
let repo: GitRepo;

before(() => {
	fixture = buildFixture({ script: [], gitRepo: {} });
	const built = fixture.gitRepo;
	assert.ok(built !== undefined, "fixture was built without a git repository");
	repo = built;
});

after(() => removeFixture(fixture));

async function parse(command: string): Promise<ParsedCommand> {
	const { parseGitCommand } = (await import(
		"../.pi/extensions/ghjig/command-parse.ts"
	)) as unknown as CommandParseModule;
	return parseGitCommand(command);
}

/**
 * The composed verdict for `command`, taken in the fixture repository.
 *
 * The git ambient of this process is pinned to the fixture's own
 * configuration for the duration, so no property of a verdict is inherited
 * from the host (§3.12).
 */
async function decide(command: string): Promise<GateVerdict> {
	const { decideCommand } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
	return withRepoGitAmbient(repo, () => decideCommand({ cwd: repo.root, command }));
}

/** True when the verdict lets the command through — the only outcome a floor forbids. */
function approves(verdict: GateVerdict): boolean {
	return verdict.decision === "allow";
}

/**
 * True when the verdict's message names the in-flow authoring affordance
 * §3.11 requires every enforced gate to owe. A block that named no
 * affordance would report rather than repair, so "blocked" and "told how to
 * proceed" are read as one property (§3.3).
 *
 * The name comes from the runtime's own export, never from a spelling
 * restated here: a rename moves the arms with it instead of leaving a
 * literal that still matches nothing and an arm that still passes.
 */
async function namesTheAffordance(verdict: GateVerdict): Promise<boolean> {
	const { AFFORDANCE_COMMAND } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
	return verdict.message.includes(AFFORDANCE_COMMAND);
}

describe("calibration: the fixture repository is one this gate governs and decides in", () => {
	it("the plainest guarded action at the default branch is blocked", async () => {
		// Every floor arm below reads a non-approval and every ceiling arm reads
		// an approval; both are satisfied by a gate that never governed this
		// repository. This arm is what distinguishes the reading's verdicts from
		// an absence of scope (§3.12).
		const verdict = await decide('git commit -m "docs: the plainest spelling"');
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("and the same action reads as a target rather than as nothing", async () => {
		assert.deepEqual(await parse('git commit -m "docs: the plainest spelling"'), {
			kind: "target",
			action: "commit",
			refSpec: null,
		});
	});
});

describe("the command word is not the first token: a guarded action behind a prefix is not approved (§3.9)", () => {
	/**
	 * Each form here runs the same guarded action as the plain spelling; each
	 * merely puts something else in the string's first position. Grouped by
	 * what occupies it, so a reading that repairs one group and not another
	 * is visible as a partial repair rather than as a passing suite.
	 *
	 * The floor has two strengths, and which one an arm carries is decided by
	 * ONE question: does the reading resolve this command's target? Not which
	 * group the form looks like it belongs to — `!` reads as a shell keyword
	 * rather than as the launcher words it is spelled among, and a redirection
	 * fused to the subcommand leaves the subcommand where it was. A form whose
	 * target the reading resolves belongs to the stronger table wherever it is
	 * written down, and an arm asserts what the reading achieves rather than
	 * less:
	 *
	 *   - **the prefix stood in front of a target the reading resolved.** The
	 *     word that decides the action is still a literal `git`, the
	 *     subcommand is still spelled out, and the ref is still the one the
	 *     branch names, so the string fixes the target exactly as the plain
	 *     spelling does. The only admissible outcome is the plain spelling's:
	 *     a block that names the branch and carries the recovery. A refusal
	 *     would be right about non-approval and wrong about everything the
	 *     actor is told — it reports a command that could not be read, and
	 *     asks for a restatement of a command that WAS read. §3.9 has a
	 *     degraded measurement refuse the inputs it would mis-measure and no
	 *     others, so folding a resolved target into "not readable" is a
	 *     widening, and a floor stated only as non-approval absorbs it
	 *     silently.
	 *   - **approval is withheld, and no outcome beyond that is this table's
	 *     to state.** The forms below include ones the reading is not
	 *     entitled to fix a target for — a launcher that may exec anything, an
	 *     assignment that moves git's repository, a word assembled at run
	 *     time, an interpreter handed program text. What every one of them
	 *     owes the floor is that the command is not approved; which
	 *     non-approving outcome lands is a property with a home of its own,
	 *     and restating it here would be a second home for it (§3.11).
	 *
	 * The two tables are never merged: the weaker predicate is satisfied by
	 * both outcomes, so a single table of it leaves the resolved group's
	 * message unmeasured — which is the whole of what separates a block from
	 * a refusal for an actor.
	 */
	const thePrefixStandsBeforeAResolvedTarget: Record<string, string[]> = {
		"an environment assignment": ["GIT_EDITOR=true git commit -m x", "GIT_AUTHOR_DATE=2020-01-01 git commit -m x"],
		"a compound statement's keyword": [
			"if true; then git commit -m x; fi",
			"for f in a; do git push origin main; done",
			"while read x; do git commit -m x; done",
			"! git commit -m x",
		],
		"a leading redirection": ["2>/dev/null git push origin main", ">out git commit -m x"],
		"a redirection fused to the subcommand": ["git commit>out", "git commit<in"],
	};

	const approvalIsWithheldAndNoMore: Record<string, string[]> = {
		"an environment assignment that moves the repository": ["GIT_DIR=/x git commit -m y"],
		"a wrapper program": [
			"sudo git push origin main",
			"env git commit -m x",
			"command git commit -m x",
			"timeout 5 git push origin main",
			"exec git commit -m x",
			"nohup git push origin main",
			"time git commit -m x",
		],
		"an expansion in the position that decides the action": ["git $SUB -m x", "$GITBIN commit -m x"],
	};

	for (const [position, commands] of Object.entries(thePrefixStandsBeforeAResolvedTarget)) {
		for (const command of commands) {
			it(`${position}, and the target behind it is named: ${command}`, async () => {
				const verdict = await decide(command);
				assert.deepEqual(
					{ decision: verdict.decision, namesTheAffordance: await namesTheAffordance(verdict) },
					{ decision: "block", namesTheAffordance: true },
					`verdict: ${JSON.stringify(verdict)}`,
				);
			});
		}
	}

	for (const [position, commands] of Object.entries(approvalIsWithheldAndNoMore)) {
		for (const command of commands) {
			it(`${position}: ${command}`, async () => {
				const verdict = await decide(command);
				assert.equal(approves(verdict), false, `verdict: ${JSON.stringify(verdict)}`);
			});
		}
	}
});

describe("the ceiling of that same rule: a command carrying no guarded action is not refused (§3.6)", () => {
	// The false-block direction. A reading that reaches the floor above by
	// treating an unfamiliar first word as unreadable would refuse most of a
	// working session, and a gate that refuses ordinary work is uninstalled
	// long before it prevents anything.
	const carryingNoGuardedAction = [
		"npm test",
		"ls -la",
		"for f in *.txt; do echo $f; done",
		"if true; then echo hi; fi",
		"./deploy.sh",
	];

	for (const command of carryingNoGuardedAction) {
		it(`${command} is allowed`, async () => {
			const verdict = await decide(command);
			assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
		});
	}
});

describe("one redirection, two spellings: the environment spelling is no more permissive (§3.11)", () => {
	it("both the option form and the environment form withhold approval", async () => {
		// The option form is already refused: `--git-dir` moves the invocation to
		// another repository, so the repository the verdict was taken against is
		// not the one the action runs in. The environment variable of the same
		// name does exactly the same thing, and the two are stated as one
		// assertion so neither can be repaired without the other (§3.11 — one
		// property, one home).
		const option = await decide("git --git-dir=/x commit -m x");
		const environment = await decide("GIT_DIR=/x git commit -m x");
		assert.deepEqual(
			{ option: approves(option), environment: approves(environment) },
			{ option: false, environment: false },
			`option: ${JSON.stringify(option)}\nenvironment: ${JSON.stringify(environment)}`,
		);
	});
});

describe("a launcher's skipped words are inspected, so an assignment cannot ride past as an argument (§3.11)", () => {
	/**
	 * A launcher runs another program under its own name, so the reading
	 * looks PAST it to the word that decides the action. Looking past is not
	 * discarding: the words in between are the launcher's own arguments, and
	 * an assignment among them reaches git exactly as a prefix assignment
	 * does. `env GIT_DIR=<other> git commit -m x` runs the commit in another
	 * repository while the string still spells a literal `git` and a
	 * spelled-out subcommand — so a reading that dropped the skipped words
	 * resolves a target and the gate decides against a repository the action
	 * never touches. Non-approval alone does not catch that: the wrong-
	 * repository verdict is itself a non-approval. What separates the two is
	 * WHICH cause the actor is told, so the floor arm reads the message.
	 *
	 * The names of the redirecting variables are module-private to the
	 * reading, and this block does not restate them — a second copy here
	 * would be a second home for a property that has one (§3.11). It pins
	 * the behaviour by OUTCOME and by EQUIVALENCE instead: whatever set the
	 * reading holds, carrying a name as a launcher's ARGUMENT must decide
	 * exactly what carrying it as a PREFIX decides. That derives the set
	 * from the runtime rather than from a list written down beside it, and
	 * it states the property in both directions at once — a redirecting name
	 * may not become permissive by moving one word to the right, and an
	 * ordinary one may not become a refusal by doing so.
	 */

	/** The redirecting spelling this file already pins in its prefix position. */
	const A_REDIRECTING_ASSIGNMENT = "GIT_DIR";

	/**
	 * Assignment names carried through the equivalence arm below.
	 *
	 * PROBES, not a restatement of the reading's set: the arm claims nothing
	 * about which of them the reading treats as redirecting, only that each
	 * decides the same thing in both positions. The calibration arm keeps the
	 * table from degenerating into one that probes no redirecting name at all.
	 */
	const carriedAssignments = [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_NAMESPACE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_CONFIG_GLOBAL",
		"FOO",
	];

	/** The same assignment in the two positions, as one commit invocation each. */
	function carriedByALauncher(name: string): string {
		return `env ${name}=/x git commit -m x`;
	}
	function writtenAsAPrefix(name: string): string {
		return `${name}=/x git commit -m x`;
	}

	it("floor — a redirecting assignment carried by a launcher is not approved, and the cause is named", async () => {
		const verdict = await decide(carriedByALauncher(A_REDIRECTING_ASSIGNMENT));
		assert.deepEqual(
			{
				approves: approves(verdict),
				namesTheRedirectingVariable: verdict.message.includes(A_REDIRECTING_ASSIGNMENT),
			},
			{ approves: false, namesTheRedirectingVariable: true },
			`verdict: ${JSON.stringify(verdict)}`,
		);
	});

	it("calibration — the probed names really do include redirecting ones", async () => {
		// Without this, an equivalence table over names the reading treats as
		// ordinary would pass while saying nothing about the hole (§3.12). More
		// than one, so the table is not carried by a single name.
		const nonApproving: string[] = [];
		for (const name of carriedAssignments) {
			const verdict = await decide(writtenAsAPrefix(name));
			if (!approves(verdict) && verdict.decision === "refuse") {
				nonApproving.push(name);
			}
		}
		assert.equal(
			nonApproving.length > 1,
			true,
			`only these probed names refuse in prefix position: ${JSON.stringify(nonApproving)}`,
		);
	});

	for (const name of carriedAssignments) {
		it(`carried as a launcher's argument, \`${name}=\` decides what it decides as a prefix`, async () => {
			const carried = await decide(carriedByALauncher(name));
			const prefixed = await decide(writtenAsAPrefix(name));
			assert.deepEqual(
				{ decision: carried.decision, message: carried.message },
				{ decision: prefixed.decision, message: prefixed.message },
				`carried: ${JSON.stringify(carried)}\nprefixed: ${JSON.stringify(prefixed)}`,
			);
		});
	}

	it("ceiling — a launcher carrying a non-redirecting assignment still resolves its target", async () => {
		// The arm that stops the repair from becoming "any launcher carrying any
		// assignment refuses". Nothing about this string moves git's repository,
		// the target is still spelled out, and the only admissible outcome is the
		// plain spelling's: a block that carries the recovery, not a refusal that
		// asks for a restatement of a command that WAS read (§3.9, §3.6).
		const verdict = await decide(`env FOO=1 git push origin ${repo.defaultBranch}`);
		assert.deepEqual(
			{ decision: verdict.decision, namesTheAffordance: await namesTheAffordance(verdict) },
			{ decision: "block", namesTheAffordance: true },
			`verdict: ${JSON.stringify(verdict)}`,
		);
	});
});

describe("an interpreter is read exactly when the program text is in the string (§3.9, §3.6)", () => {
	/**
	 * The two ends of ONE discriminator, in one block because no repair may
	 * satisfy either end alone.
	 *
	 * Naming interpreters and refusing every invocation of them closes the
	 * floor and refuses `bash deploy.sh`, an ordinary command that carries no
	 * guarded action the string can see. Reading the program text only where
	 * a substitution produced it opens the ceiling and admits
	 * `eval "git push origin main"`, whose program text is right there in the
	 * string.
	 *
	 * What separates the two is neither the interpreter's name nor where the
	 * scan sits: it is whether the PROGRAM TEXT IS PRESENT in the string
	 * handed to the reading. Present, it is read, exactly as a substitution
	 * body already is. Absent — a script named rather than quoted — the
	 * command is the declared script residual this gate enumerates in place
	 * and homes at the tiers below the session (§3.2, §3.11).
	 */
	const programTextIsInTheString = [
		'bash -c "git commit -m x"',
		'sh -c "git push origin main"',
		'zsh -c "git commit"',
		'eval "git push origin main"',
		'eval "git commit -m x"',
	];

	const programTextIsNotInTheString = [
		"source ./venv/bin/activate",
		". ./env.sh",
		'eval "$(direnv hook bash)"',
		"npm test && source foo.sh",
		"bash deploy.sh",
		"sh ./scripts/build.sh",
		"bash",
	];

	for (const command of programTextIsInTheString) {
		it(`floor — the text is present and carries a guarded action: ${command}`, async () => {
			const verdict = await decide(command);
			assert.equal(approves(verdict), false, `verdict: ${JSON.stringify(verdict)}`);
		});
	}

	for (const command of programTextIsNotInTheString) {
		it(`ceiling — no guarded action the string carries: ${command}`, async () => {
			const verdict = await decide(command);
			assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
		});
	}
});

describe("a trailing comment is a comment, and a hash inside a word is not (§3.11)", () => {
	it("floor — a push at the default branch with a trailing comment is blocked", async () => {
		// The comment is not part of the target. Reading it as two more
		// positional words turns a decidable protected-ref push into a refusal
		// that names a cause the command does not have — the wrong message for
		// the wrong reason, on a command that should simply block.
		const verdict = await decide("git push origin main # ok");
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("ceiling — a hash inside a word still names the destination it spells", async () => {
		// A `#` mid-word is an ordinary character. A repair that strips from the
		// first `#` rather than from a word boundary silently retargets this
		// push.
		assert.deepEqual(await parse("git push origin ma#in"), {
			kind: "target",
			action: "push",
			refSpec: "ma#in",
		});
	});

	it("ceiling — a hash inside a quoted message leaves the action decided", async () => {
		// The other shape of the same mistake: stripping before the quoting is
		// resolved truncates the message, leaves the quote unbalanced, and turns
		// a decidable commit into a refusal.
		const verdict = await decide('git commit -m "fix#3"');
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("a here-document's body is data a program is fed, and its terminator ends that data (§3.6, §3.9)", () => {
	/**
	 * The same data-or-structure question as the quoting and comment arms
	 * above, asked about the one construct that spans lines.
	 *
	 * A here-document's body is input the shell hands to a program, not a
	 * sequence of commands. Writing a document, a runbook or a CI snippet
	 * whose text contains a push line is ordinary work, so lexing the body as
	 * live segments blocks a command that advances no ref — and this class
	 * ships no in-session escape, so that false block costs a trip outside the
	 * session (§3.6, §3.8).
	 *
	 * Both ends are stated here because a repair that satisfies either one
	 * alone is a hole rather than a fix:
	 *
	 *   - the **ceiling** — the body's push line is data, in each of the three
	 *     delimiter spellings a shell accepts. They differ only in what the
	 *     shell expands INSIDE the body; none of them changes where the body
	 *     ends, so they are one property and are pinned together.
	 *   - the **floor** — the body ENDS at its terminator. A reading that
	 *     treated everything after `<<` as data would satisfy every ceiling
	 *     arm above and swallow the guarded action that follows the
	 *     terminator, turning the relief into a way of hiding a push inside
	 *     any command that opens a here-document.
	 *
	 * The destination is the fixture repository's own default branch, read
	 * from the fixture rather than spelled here, so the floor arm's block is
	 * attributable to the ref the repository actually protects (§3.12).
	 */
	const delimiterSpellings: Record<string, (bodyLine: string) => string> = {
		"a quoted delimiter": (bodyLine) => `cat <<'EOF' > note.txt\n${bodyLine}\nEOF\n`,
		"an unquoted delimiter": (bodyLine) => `cat <<EOF > note.txt\n${bodyLine}\nEOF\n`,
		"the dash form, whose terminator may be tab-indented": (bodyLine) =>
			`cat <<-EOF > note.txt\n\t${bodyLine}\n\tEOF\n`,
	};

	/** The line that would be a guarded action if it were a command rather than data. */
	function theGuardedLine(): string {
		return `git push origin ${repo.defaultBranch}`;
	}

	for (const [spelling, document] of Object.entries(delimiterSpellings)) {
		it(`ceiling — the body carries a push line and is still data: ${spelling}`, async () => {
			const verdict = await decide(document(theGuardedLine()));
			assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
		});
	}

	it("floor — the body does not swallow the rest: a guarded action after the terminator still decides", async () => {
		const action = theGuardedLine();
		const verdict = await decide(`${delimiterSpellings["a quoted delimiter"](action)}${action}`);
		assert.deepEqual(
			{ decision: verdict.decision, namesTheAffordance: await namesTheAffordance(verdict) },
			{ decision: "block", namesTheAffordance: true },
			`verdict: ${JSON.stringify(verdict)}`,
		);
	});
});
