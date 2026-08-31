/**
 * Command reading for the protected-branch gate (issue #33, AC1/AC2/AC5).
 *
 * Before the gate can say what a command lands on, something has to read
 * the command. That reading is three-valued by contract, and the third
 * value is the point: `none` (this command lands on no ref), `target`
 * (this command lands on exactly this ref spec), and `undecidable` (a
 * guarded action is present but the string does not determine its target).
 * A two-valued reading has nowhere to put the third case and must fold it
 * into one of the other two — folding it into `none` is a silent wrong
 * allow, which §3.9 forbids: an unmeasurable input refuses.
 *
 * The residual this reading declares, rather than leaves implicit: a
 * command that names a script runs whatever that script contains, and a
 * lexer sees the script's name, not its contents. That vector is
 * deliberately not modelled here (§3.11's in-place enumeration of
 * unmodelled bypass vectors); it is covered where it is coverable, at the
 * git layer (§3.3's tier-2 adapters).
 *
 * The parser is loaded per arm rather than at file load, so a failure to
 * load it is reported by the arm that needed it instead of erasing the
 * whole file's results.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ParsedCommand } from "../.pi/extensions/ghjig/command-parse.ts";
import { buildFixture, type Fixture, type GitRepo, removeFixture, withRepoGitAmbient } from "./harness/run-pi.ts";

/**
 * The contract these arms assert, taken from the module that owns it rather
 * than retyped here: a local copy stops matching silently on a rename, and a
 * shape nothing checks is a shape nothing pins. `refSpec` is null when the
 * command carries none.
 */
interface CommandParseModule {
	parseGitCommand(command: string): ParsedCommand;
}
/** Composition is homed in `gate.ts`, not in the lexer or the ref reader (§3.11). */
interface GateModule {
	decideCommand(input: { cwd: string; command: string }): { decision: "allow" | "block" | "refuse" };
}

async function parse(command: string): Promise<ParsedCommand> {
	const { parseGitCommand } = (await import("../.pi/extensions/ghjig/command-parse.ts")) as unknown as CommandParseModule;
	return parseGitCommand(command);
}

const COMMIT_TARGET: ParsedCommand = { kind: "target", action: "commit", refSpec: null };
const PUSH_MAIN: ParsedCommand = { kind: "target", action: "push", refSpec: "main" };

let fixture: Fixture;
let repo: GitRepo;

before(() => {
	fixture = buildFixture({ script: [], gitRepo: {} });
	const built = fixture.gitRepo;
	assert.ok(built !== undefined, "fixture was built without a git repository");
	repo = built;
	repo.switchToNewBranch("topic");
});

after(() => removeFixture(fixture));

describe("kind none: the command lands on no ref", () => {
	it("a command that is not git at all", async () => {
		assert.deepEqual(await parse("echo hello && ls -la"), { kind: "none" });
	});

	it("a script that itself runs git — a declared residual, not an oversight", async () => {
		// The reading is lexical: it sees `./deploy.sh`, never the file's
		// contents, and it does not pretend otherwise. Claiming `undecidable`
		// for every command that could conceivably invoke git would refuse
		// nearly every command in a working session; the vector is instead
		// declared here and left to the tiers that bind below the session
		// (§3.2, §3.3).
		assert.deepEqual(await parse("./deploy.sh --production"), { kind: "none" });
	});
});

describe("kind target: the command names exactly one ref target", () => {
	it("a commit", async () => {
		assert.deepEqual(await parse('git commit -m "docs: a change"'), COMMIT_TARGET);
	});

	it("a commit behind an unrelated first segment", async () => {
		assert.deepEqual(await parse('git add -A && git commit -m "docs: a change"'), COMMIT_TARGET);
	});

	it("a bare push, whose target the string leaves to configuration", async () => {
		assert.deepEqual(await parse("git push"), { kind: "target", action: "push", refSpec: null });
	});

	it("a push naming a branch", async () => {
		assert.deepEqual(await parse("git push origin main"), PUSH_MAIN);
	});

	it("a push naming a source and a destination", async () => {
		assert.deepEqual(await parse("git push origin HEAD:main"), {
			kind: "target",
			action: "push",
			refSpec: "HEAD:main",
		});
	});

	it("a forced push written as a leading plus on the refspec", async () => {
		assert.deepEqual(await parse("git push origin +topic:refs/heads/main"), {
			kind: "target",
			action: "push",
			refSpec: "+topic:refs/heads/main",
		});
	});

	it("a deletion written as an empty source", async () => {
		assert.deepEqual(await parse("git push origin :main"), {
			kind: "target",
			action: "push",
			refSpec: ":main",
		});
	});

	it("a deletion written with the flag", async () => {
		assert.deepEqual(await parse("git push --delete origin main"), PUSH_MAIN);
	});

	it("force flags never reach the refspec extractor", async () => {
		// The force-push class is covered by subsumption (§3.3): a forced push
		// yields the same target as the same push unforced, so it is refused as
		// a protected-ref push and needs no gate arm of its own. That holds only
		// while the flags leave the target unchanged, which is what this pins.
		const forced = [
			"git push --force origin main",
			"git push -f origin main",
			"git push --force-with-lease origin main",
		];
		assert.deepEqual(await Promise.all(forced.map(parse)), [PUSH_MAIN, PUSH_MAIN, PUSH_MAIN]);
	});

	it("a separator inside a quoted string does not separate segments", async () => {
		// The message is data, not command structure. Reading it as structure
		// would split the command and lose the action it belongs to.
		assert.deepEqual(await parse('git commit -m "fix: guard a; b && c"'), COMMIT_TARGET);
	});
});

describe("kind undecidable: a guarded action whose target the string does not fix (§3.9)", () => {
	const undecidable = async (command: string): Promise<string> => (await parse(command)).kind;

	it("command substitution", async () => {
		assert.equal(await undecidable('git push origin $(cat .branch)'), "undecidable");
	});

	it("backtick substitution", async () => {
		assert.equal(await undecidable("git push origin `cat .branch`"), "undecidable");
	});

	it("eval", async () => {
		assert.equal(await undecidable('eval "git push origin main"'), "undecidable");
	});

	it("an unbalanced quote", async () => {
		assert.equal(await undecidable('git commit -m "unterminated'), "undecidable");
	});

	it("a directory change ahead of the action", async () => {
		// The action's repository is no longer the one the verdict was taken
		// against, so the target is not the one the string appears to name.
		assert.equal(await undecidable('cd /elsewhere && git commit -m "docs: a change"'), "undecidable");
	});

	it("a repository redirected with -C", async () => {
		assert.equal(await undecidable('git -C /elsewhere commit -m "docs: a change"'), "undecidable");
	});

	it("a repository redirected with --git-dir", async () => {
		assert.equal(await undecidable('git --git-dir=/elsewhere/.git commit -m "docs: a change"'), "undecidable");
	});

	it("a work tree redirected with --work-tree", async () => {
		assert.equal(await undecidable('git --work-tree=/elsewhere commit -m "docs: a change"'), "undecidable");
	});

	it("configuration overridden for one invocation with -c", async () => {
		// `-c push.default=matching` changes what a bare push targets, so the
		// resolution the gate would perform is not the resolution that runs.
		assert.equal(await undecidable("git -c push.default=matching push"), "undecidable");
	});

	it("a push of every ref", async () => {
		assert.equal(await undecidable("git push --all origin"), "undecidable");
	});

	it("a mirroring push", async () => {
		assert.equal(await undecidable("git push --mirror origin"), "undecidable");
	});

	it("a refspec carrying a variable expansion", async () => {
		assert.equal(await undecidable('git push origin "$BRANCH"'), "undecidable");
	});
});

describe("AC5: an undecidable reading is not an approval (§3.9)", () => {
	it("routes to a non-approving verdict in a repository where the same action on a topic branch passes", async () => {
		// The composed verdict is what matters: a parser that answers
		// `undecidable` while the gate reads that as "nothing to check" is a
		// silent wrong allow. The fixture is on a topic branch, so the same
		// action without the undecidable construct is the allow case — the
		// non-approval here comes from the reading, not from the branch.
		const { decideCommand } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
		const verdict = withRepoGitAmbient(repo, () =>
			decideCommand({ cwd: repo.root, command: 'eval "git push origin main"' }),
		);
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});
