/**
 * The two edges of the gate's scope (issue #33; §4.6, §4.7).
 *
 * Scope has an inner edge and an outer edge, and both are contracts:
 *
 *   - **Inner** (§4.7): a repository binds at its root only, never
 *     recursively into subprojects. A repository that sits BELOW the one
 *     under governance keeps its own configuration untouched, so enforcement
 *     is inert there. This is the edge that stops a widening of scope from
 *     swallowing a vendored or nested project.
 *   - **Outer** (§4.6): enforcement is registry-scoped and transparently
 *     inert outside it — a guardrail, not a sandbox. A decision taken about
 *     a repository the shell does not govern must not leave its evidence in
 *     the governed repository's state; that state is what every later
 *     calibration reads, and a record about a foreign tree is a claim about
 *     work this shell never governed (§5.5).
 *
 * Both edges are relative to a NAMED root, and the outer one is only
 * expressible that way: "foreign" is a relation, and a decision that names
 * no governed root has nothing for a working directory to be foreign to. The
 * root is therefore an input a caller supplies, as `locateRepoRootFrom`
 * parameterises discovery — with the production caller passing the root the
 * runtime self-located to. Where no root is named, the repository containing
 * the working directory is the subject, which is what every arm that hands
 * the gate a fixture repository and nothing else means.
 *
 * Both edges are measured the same way — by what a decision LEAVES BEHIND —
 * because inertness and enforcement are indistinguishable in their effect on
 * a repository nobody touched, and only the record tells them apart (§3.12).
 * The silence is the contract at this granularity: where nothing was
 * examined, nothing is recorded (§3.8), and recording every inert decision
 * would write a line for every command in every directory outside the
 * governed root. Whether the gate is armed for a SESSION at all is a
 * different question with a different home — the durable session entry
 * (§5.9), pinned in this file's end-to-end sibling.
 *
 * Two structural rules, inherited from this issue's other unit suites:
 * modules are imported inside the arm that needs them, so a load failure is
 * reported by that arm rather than erasing the file's results; and every
 * state root is a fresh disposable directory, so no arm reads another arm's
 * records and nothing operational is ever a destination (§5.5).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GateDecision } from "../.pi/extensions/ghjig/gate.ts";
import {
	buildFixture,
	type Fixture,
	type GitRepo,
	listTreeEntries,
	removeFixture,
	withRepoGitAmbient,
} from "./harness/run-pi.ts";

/** The decision type comes from the module that owns it, never a local copy. */
interface GateVerdict {
	decision: GateDecision;
	arm: string;
	message: string;
}
interface GateModule {
	applyGate(input: {
		cwd: string;
		command: string;
		stateRoot: string;
		/** The root under governance, where the caller knows which one it is. */
		governedRoot?: string;
	}): GateVerdict;
}

async function gate(): Promise<GateModule> {
	return (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
}

const GUARDED_CONTENT = "GHJIG_GUARDED_CONTENT_PROBE";
const GUARDED_COMMIT = `git commit --allow-empty -m "docs: ${GUARDED_CONTENT}"`;

let fixture: Fixture;
let governedRepo: GitRepo;
let foreignFixture: Fixture;
let foreignRepo: GitRepo;

function repoOf(built: Fixture): GitRepo {
	const repo = built.gitRepo;
	assert.ok(repo !== undefined, "fixture was built without a git repository");
	return repo;
}

/** A fresh disposable state root — nothing here shares a destination. */
function disposableStateRoot(prefix: string): string {
	return mkdtempSync(join(fixture.root, prefix));
}

/** Everything a decision left behind under a state root; absence reads as emptiness. */
function trace(stateRoot: string): string[] {
	return existsSync(stateRoot) ? listTreeEntries(stateRoot) : [];
}

before(() => {
	fixture = buildFixture({ script: [], gitRepo: {} });
	governedRepo = repoOf(fixture);
	foreignFixture = buildFixture({ script: [], gitRepo: {} });
	foreignRepo = repoOf(foreignFixture);
});

after(() => {
	removeFixture(fixture);
	removeFixture(foreignFixture);
});

describe("calibration: the gate does govern the repository these arms hand it", () => {
	it("a guarded commit at the default branch of the fixture repository is a decided block", async () => {
		// The instrument reporting itself sound. Every arm below reads either an
		// emptiness or a trace, and both readings are satisfied by a gate that
		// never governed the fixture at all — this arm is what separates "the
		// scope rule held" from "nothing was in scope" (§3.12).
		const { applyGate } = await gate();
		const stateRoot = disposableStateRoot("calibration-state-");
		const verdict = withRepoGitAmbient(governedRepo, () =>
			applyGate({ cwd: governedRepo.root, command: GUARDED_COMMIT, stateRoot }),
		);
		assert.equal(verdict.decision, "block", `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("the inner edge: a repository below another one is a subproject, not a subject (§4.7)", () => {
	/**
	 * The ceiling this issue's scope repair must not cross. A repository
	 * nested inside another one keeps its own configuration untouched, so
	 * nothing is examined there and therefore nothing is recorded (§3.8) —
	 * and a repair that widened scope by simply dropping the enclosing check
	 * would turn every vendored subproject into a subject of the outer
	 * repository's rules.
	 *
	 * The sub-repository is built with no remote pointer of its own, so a
	 * scope rule that DID reach into it would have something unmeasurable to
	 * decide about and would leave a refusal on the record. The emptiness
	 * below therefore distinguishes inertness from every other outcome, not
	 * merely from a block.
	 */
	let subRepository: string;

	before(() => {
		subRepository = join(governedRepo.root, "vendor", "sub");
		governedRepo.git(["init", "-q", "-b", "vendored", subRepository], governedRepo.root);
	});

	it("records nothing at all for a guarded action inside it", async () => {
		const { applyGate } = await gate();
		const stateRoot = disposableStateRoot("subproject-state-");
		withRepoGitAmbient(governedRepo, () =>
			applyGate({ cwd: subRepository, command: GUARDED_COMMIT, stateRoot }),
		);
		assert.deepEqual(trace(stateRoot), []);
	});
});

describe("the outer edge: a decision about a foreign repository leaves no evidence in the governed one (§4.6, §5.5)", () => {
	/**
	 * The governed root is NAMED here, because the property is a relation and
	 * cannot be stated without both of its ends: a working directory is
	 * foreign to a particular root, never in the abstract. The root named is
	 * the fixture repository this file already governs everything else
	 * against; the working directory is a second, complete fixture repository
	 * — its own remote pointer, its own default branch — so a gate that DID
	 * examine it would have a fully measurable subject and would leave a
	 * decided record behind, not a degraded one. What the arms forbid is that
	 * record landing in the named root's evidence, which is the surface every
	 * later calibration reads.
	 *
	 * The pair below is the point. Both arms hand the gate the same working
	 * directory and the same governed root and differ only in WHERE THE STORE
	 * SITS — outside that root in one, inside it in the other. What a decision
	 * governs and where its evidence is kept are independent: the state root
	 * is relocatable by design (§5.5's disposable-root carve-out is the whole
	 * reason the seam exists), and a scope that reads the store to decide what
	 * it governs is a scope that answers differently under the seam than in
	 * operation. A suite would then measure the relocated path while the
	 * operational one ran unmeasured — the exact shape in which a scope defect
	 * survives a green suite (§3.12). Two arms, one claim, so no repair can
	 * satisfy the arrangement it happens to be tested under.
	 *
	 * Neither state root is any operational path: one is a disposable
	 * directory beside the governed fixture, the other the disposable
	 * fixture's own `.ghjig/state` (§5.5).
	 */
	async function decisionAboutTheForeignRepository(stateRoot: string): Promise<void> {
		const { applyGate } = await gate();
		withRepoGitAmbient(foreignRepo, () =>
			applyGate({
				cwd: foreignRepo.root,
				command: GUARDED_COMMIT,
				stateRoot,
				governedRoot: governedRepo.root,
			}),
		);
	}

	it("writes nothing under a store kept outside the governed root", async () => {
		const stateRoot = disposableStateRoot("relocated-store-");
		await decisionAboutTheForeignRepository(stateRoot);
		assert.deepEqual(trace(stateRoot), []);
	});

	it("writes nothing under the governed root's own store either", async () => {
		const stateRoot = join(governedRepo.root, ".ghjig", "state");
		await decisionAboutTheForeignRepository(stateRoot);
		assert.deepEqual(trace(stateRoot), []);
	});
});

describe("a directory in no repository is inert, and inert means silent (§3.8, §4.6)", () => {
	/**
	 * The per-decision granularity, stated as the ceiling it is. Enforcement
	 * outside the governed root is transparently inert by design — a
	 * guardrail, not a sandbox — and where nothing was examined, nothing is
	 * recorded. Writing a record here would put a line in the evidence surface
	 * for every command issued in every directory on the host, which buries
	 * the signal the surface exists to raise.
	 *
	 * That silence is not the disarm bar's concern (§5.9), and reading it as
	 * one is the mistake this comment exists to prevent: the bar is about a
	 * STATE — is the gate armed for this session at all — whose remedy shape
	 * is one debounced line per degraded state, at session granularity. That
	 * question is pinned on the durable session entry, in this file's
	 * end-to-end sibling. Repairing one by breaking the other trades a real
	 * surface for noise.
	 */
	it("records nothing for a guarded action in a directory that is no repository", async () => {
		const { applyGate } = await gate();
		// A directory that is no repository, minted inside the fixture so it is
		// disposed with everything else and nothing outside a disposable root is
		// ever created (§5.5).
		const ungoverned = mkdtempSync(join(fixture.root, "ungoverned-"));
		const stateRoot = disposableStateRoot("inert-state-");
		applyGate({ cwd: ungoverned, command: GUARDED_COMMIT, stateRoot });
		assert.deepEqual(trace(stateRoot), []);
	});
});
