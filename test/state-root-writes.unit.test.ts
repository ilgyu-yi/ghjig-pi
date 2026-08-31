/**
 * What creating a state root is allowed to touch (issue #33, AC7; §4.6,
 * §4.7, §5.5).
 *
 * The state root is where this shell keeps its own evidence, and creating
 * it is the one act that writes into a repository's working tree on the
 * shell's own behalf. §4.7 bounds that act from two
 * sides: an install never overwrites a pre-existing same-named asset — the
 * target's choice wins — and the host outside the governed repository is not
 * touched at all. §4.6 adds the resolution rule that makes both checkable:
 * the path written must be the path read, so an entry planted in the way
 * cannot silently move where the write lands.
 *
 * Each failure fixture here is file-TYPE- or absence-shaped — a link where a
 * file is expected, a file that is already there, a link in a path component
 * — never a permission bit, which would answer differently for uid 0 and
 * false-red a suite in a root container (§3.12).
 *
 * Nothing outside a disposable root is ever named as a destination: the
 * governed repository these arms create and write into is a fixture, and the
 * one arm that must name a path of the real governed tree only RESOLVES,
 * which creates nothing (§5.5).
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { AUDIT_FILE_NAME } from "../.pi/extensions/ghjig/audit.ts";
import { isStrictDescendant } from "../.pi/extensions/ghjig/locate.ts";
import { ensureStateRoot, resolveStateRoot, STATE_SEAM } from "../.pi/extensions/ghjig/state-root.ts";
import {
	buildFixture,
	type Fixture,
	type GitRepo,
	listTreeEntries,
	removeFixture,
	repoRoot,
	withRepoGitAmbient,
} from "./harness/run-pi.ts";

interface GateVerdict {
	decision: "allow" | "block" | "refuse";
	arm: string;
	message: string;
}
interface GateModule {
	applyGate(input: { cwd: string; command: string; stateRoot: string }): GateVerdict;
}

/** The gate is loaded inside the arm that needs it — the module under decision. */
async function gate(): Promise<GateModule> {
	return (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
}

const GUARDED_CONTENT = "GHJIG_GUARDED_CONTENT_PROBE";
const GUARDED_COMMIT = `git commit --allow-empty -m "docs: ${GUARDED_CONTENT}"`;

/**
 * The bytes of a file the shell's own state is NOT. A link at the exclusion
 * path points here, so "the write did not follow the link" is measured on the
 * link's target rather than on the link — §4.6's divergence, where the write
 * succeeds, the read finds nothing, and both report clean.
 */
const VICTIM_CONTENT = "ORIGINAL-CONTENT-OF-A-FILE-THE-EXCLUSION-IS-NOT\n";

/** A rule a repository already had, which no state-root creation may replace. */
const PRE_EXISTING_EXCLUSION = "# the target repository's own rule, written before this shell ever ran\nbuild/\n";

let fixture: Fixture;
let repo: GitRepo;
let savedSeam: string | undefined;

before(() => {
	fixture = buildFixture({ script: [], gitRepo: {} });
	const built = fixture.gitRepo;
	assert.ok(built !== undefined, "fixture was built without a git repository");
	repo = built;
});

after(() => removeFixture(fixture));

beforeEach(() => {
	savedSeam = process.env[STATE_SEAM];
	delete process.env[STATE_SEAM];
});

afterEach(() => {
	if (savedSeam === undefined) {
		delete process.env[STATE_SEAM];
	} else {
		process.env[STATE_SEAM] = savedSeam;
	}
});

/** A fresh disposable state root inside the fixture. */
function disposableStateRoot(prefix: string): string {
	return mkdtempSync(join(fixture.root, prefix));
}

/**
 * The name creation gives the exclusion it writes, discovered by watching a
 * creation rather than restated here.
 *
 * The name is the runtime's choice, not this suite's: asking a fresh
 * creation what it produced keeps the arms below pointing at whatever it
 * writes, rather than at a literal that a rename would leave matching
 * nothing (§3.11).
 */
function exclusionFileName(): string {
	const probe = disposableStateRoot("exclusion-name-probe-");
	ensureStateRoot(probe);
	const written = listTreeEntries(probe);
	assert.equal(written.length, 1, `creation wrote an unexpected entry set: ${JSON.stringify(written)}`);
	return written[0];
}

/** Applies the gate once, so a real decision is recorded under `stateRoot`. */
async function decisionRecordedAt(stateRoot: string): Promise<void> {
	const { applyGate } = await gate();
	withRepoGitAmbient(repo, () => applyGate({ cwd: repo.root, command: GUARDED_COMMIT, stateRoot }));
}

describe("a link at the exclusion path is not a destination (§4.6)", () => {
	/**
	 * The state root's own contents are read back by the shell, so where they
	 * land has to be where they were meant to land. A link planted at the
	 * exclusion path redirects the write out of the state root entirely: the
	 * creation reports success, the file it meant to write is not there, and
	 * some other file has been replaced instead — with content that ends in a
	 * pattern excluding everything.
	 */
	async function afterADecisionOverALinkedExclusion(): Promise<{ victim: string; stateRoot: string }> {
		const stateRoot = disposableStateRoot("linked-exclusion-state-");
		const victim = join(fixture.root, `linked-exclusion-victim-${Date.now()}`);
		writeFileSync(victim, VICTIM_CONTENT);
		symlinkSync(victim, join(stateRoot, exclusionFileName()));
		await decisionRecordedAt(stateRoot);
		return { victim, stateRoot };
	}

	it("calibration — a decision really was recorded under that state root", async () => {
		// Without this, "the victim is unchanged" would also pass on a run in
		// which nothing was ever written anywhere (§3.12).
		const { stateRoot } = await afterADecisionOverALinkedExclusion();
		assert.equal(existsSync(join(stateRoot, AUDIT_FILE_NAME)), true);
	});

	it("the file the link points at is unchanged", async () => {
		const { victim } = await afterADecisionOverALinkedExclusion();
		assert.equal(
			readFileSync(victim, "utf8"),
			VICTIM_CONTENT,
			"creating the state root followed a link out of it: the write target is no longer the read target",
		);
	});
});

describe("a state root that is already there is left as it is found (§4.7)", () => {
	/**
	 * Creation is documented as idempotent, and §4.7 states what idempotent
	 * has to mean at a target that is not empty: an install never overwrites a
	 * pre-existing same-named asset — it skips, warns, and names the remedy,
	 * because the target's choice wins. A repository that already keeps a rule
	 * at that path keeps it.
	 */
	async function afterADecisionOverAPreExistingExclusion(): Promise<{ path: string; stateRoot: string }> {
		const stateRoot = disposableStateRoot("pre-existing-exclusion-state-");
		const path = join(stateRoot, exclusionFileName());
		writeFileSync(path, PRE_EXISTING_EXCLUSION);
		await decisionRecordedAt(stateRoot);
		return { path, stateRoot };
	}

	it("calibration — a decision really was recorded under that state root", async () => {
		const { stateRoot } = await afterADecisionOverAPreExistingExclusion();
		assert.equal(existsSync(join(stateRoot, AUDIT_FILE_NAME)), true);
	});

	it("the rule the target already had is still its rule", async () => {
		const { path } = await afterADecisionOverAPreExistingExclusion();
		assert.equal(readFileSync(path, "utf8"), PRE_EXISTING_EXCLUSION);
	});
});

describe("a link in a path component is not a way out of the state root (§4.6)", () => {
	/**
	 * THIS BLOCK PINS THE INVARIANT, NOT A REMEDY — and that distinction is
	 * the whole reason it reads the way it does.
	 *
	 * The threat: the final component of the audit destination is opened
	 * without following links, which is the guard the sink already carries. A
	 * link one component HIGHER is untouched by that guard — the whole state
	 * root, evidence and all, then lands outside the tree its path names, and
	 * every later read follows it there without noticing.
	 *
	 * The invariant §4.6 states about that is `the path written is the path
	 * read`: no write lands outside the state root through a linked
	 * component. Two remedies satisfy it. One removes the link and creates
	 * the real directory in its place. The other refuses to follow it at
	 * all — lstat, decline, report, degrade — which is exactly how the
	 * evidence sink already handles the same threat one component lower, and
	 * it is the non-destructive one: deleting an entry a user created is the
	 * only destructive act in this runtime.
	 *
	 * An earlier shape of this arm asserted that the CREATED directory
	 * realpaths back inside the repository. Only the deleting remedy can
	 * satisfy that, so the arm measured the remedy and not the rule: adopting
	 * the safer remedy would have reddened a guard that was supposed to be
	 * protecting the property, and a guard that has to be rewritten to permit
	 * a safer implementation is a harness defect (§3.12). The assertions
	 * below therefore read what the link's target still holds, and which of
	 * the two admissible outcomes landed — both of which either remedy
	 * satisfies.
	 *
	 * The fixture is file-TYPE-shaped throughout: a link where a directory is
	 * expected, never a permission bit, which would answer differently for
	 * uid 0 (§3.12).
	 */

	/** Bytes of a directory the shell's state root is NOT, so "unchanged" is measurable. */
	const LINK_TARGET_ENTRY = "a-file-the-shell-did-not-write";
	const LINK_TARGET_CONTENT = "CONTENT-OF-A-DIRECTORY-THE-STATE-ROOT-IS-NOT\n";

	/**
	 * The two component names the runtime composes a state root out of, read
	 * off a resolution rather than restated here — a rename moves this block
	 * with it instead of leaving literals that arrange nothing and an arm that
	 * still passes (§3.11). Resolution creates nothing, so the derivation
	 * touches no directory of the governed tree (§5.5).
	 */
	function componentNames(): { namespace: string; state: string } {
		const operational = resolveStateRoot().root;
		return { namespace: basename(dirname(operational)), state: basename(operational) };
	}

	interface Arrangement {
		/** The tree the state root's path names — what "inside" means here. */
		owner: string;
		/** The component the link stands at. */
		linkedComponent: string;
		/** The directory that link points at, outside `owner`. */
		linkTarget: string;
		/** What `linkTarget` held before creation ran. */
		heldBefore: string[];
		/** The state root creation is asked for. */
		stateRoot: string;
	}

	/** Plants a link at the component above the state directory. Creates nothing under it. */
	function aStateRootBehindALinkedComponent(): Arrangement {
		const { namespace, state } = componentNames();
		const owner = mkdtempSync(join(fixture.root, "tree-the-path-names-"));
		const linkTarget = mkdtempSync(join(fixture.root, "a-directory-outside-that-tree-"));
		writeFileSync(join(linkTarget, LINK_TARGET_ENTRY), LINK_TARGET_CONTENT);
		const linkedComponent = join(owner, namespace);
		symlinkSync(linkTarget, linkedComponent, "dir");
		return {
			owner,
			linkedComponent,
			linkTarget,
			heldBefore: listTreeEntries(linkTarget),
			stateRoot: join(linkedComponent, state),
		};
	}

	/**
	 * Runs `act` with the shell's own reporting channel captured, answering
	 * whether anything was reported.
	 *
	 * `console.warn` is the channel this runtime degrades on — the evidence
	 * sink reports its refusal the same way — so capturing it is reading the
	 * runtime's report rather than substituting for it. It also keeps a
	 * deliberate warning out of the suite's output.
	 */
	function reportsWhile(act: () => void): boolean {
		const original = console.warn;
		let reported = false;
		console.warn = (): void => {
			reported = true;
		};
		try {
			act();
		} finally {
			console.warn = original;
		}
		return reported;
	}

	const CREATED_INSIDE = "a state root exists, and it resolves inside the tree its path names";
	const DECLINED_AND_REPORTED = "no state root was created, and the condition was reported";
	const CREATED_OUTSIDE = "a state root exists OUTSIDE the tree its path names";
	const DECLINED_IN_SILENCE = "no state root was created, and nothing was reported";
	const ADMISSIBLE = [CREATED_INSIDE, DECLINED_AND_REPORTED];

	function outcomeOf(arranged: Arrangement, reported: boolean): string {
		if (!existsSync(arranged.stateRoot)) {
			return reported ? DECLINED_AND_REPORTED : DECLINED_IN_SILENCE;
		}
		return isStrictDescendant(realpathSync(arranged.stateRoot), realpathSync(arranged.owner))
			? CREATED_INSIDE
			: CREATED_OUTSIDE;
	}

	it("calibration — the arrangement really puts a link in the state root's path", () => {
		// Both arms below are satisfied by a run in which no link was ever
		// planted, so the arrangement itself is measured once (§3.12).
		const arranged = aStateRootBehindALinkedComponent();
		assert.equal(lstatSync(arranged.linkedComponent).isSymbolicLink(), true);
	});

	it("nothing is written through the link: its target still holds what it held", () => {
		const arranged = aStateRootBehindALinkedComponent();
		reportsWhile(() => ensureStateRoot(arranged.stateRoot));
		assert.deepEqual(
			listTreeEntries(arranged.linkTarget),
			arranged.heldBefore,
			"creating the state root wrote through a linked component: the path written is not the path read",
		);
	});

	it("and the outcome is one of the two the invariant admits", () => {
		const arranged = aStateRootBehindALinkedComponent();
		const reported = reportsWhile(() => ensureStateRoot(arranged.stateRoot));
		const outcome = outcomeOf(arranged, reported);
		assert.equal(ADMISSIBLE.includes(outcome), true, `the outcome was: ${outcome}`);
	});
});

describe("the seam's admissible target is bounded on both sides (§5.5, §4.6)", () => {
	/**
	 * The rule as written refuses the governed root and everything below it.
	 * An ANCESTOR of the governed root is the other side of the same boundary
	 * and is refused by nothing: a state root there contains the whole
	 * governed repository, so creating it writes a rule over a directory the
	 * shell does not govern — the host mutation §4.7 forbids — and what it
	 * holds reaches wider than the tree the shell was pointed at.
	 *
	 * An ancestor cannot be synthesized: the governed root is fixed by the
	 * runtime's own installed location, so the only path that stands in the
	 * relation is a real directory above this repository. The arm therefore
	 * only RESOLVES, and resolution creates nothing — a property this suite's
	 * sibling arms already pin — so no directory outside a disposable root is
	 * written, read, or otherwise touched, and no home directory is named.
	 */
	function refusalMessage(seam: string): string {
		process.env[STATE_SEAM] = seam;
		try {
			// A refusal is reported as its message rather than as a boolean, so
			// an arm can say which refusal it got.
			resolveStateRoot();
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	it("refuses a target that CONTAINS the governed repository", () => {
		assert.notEqual(
			refusalMessage(dirname(repoRoot())),
			"",
			"a directory containing the repository under governance was admitted as the state root",
		);
	});
});
