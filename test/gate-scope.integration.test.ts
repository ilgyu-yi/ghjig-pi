/**
 * The gate's scope, measured where a working clone actually sits (issue #33,
 * AC1, AC2; §4.6, §4.7).
 *
 * A governed repository is not always the outermost repository on the
 * filesystem. A clone checked out inside another checkout — a workspace
 * directory that is itself under version control, a vendored tree, a
 * container image whose root is a repository — is an ordinary arrangement,
 * and §4.6 scopes enforcement by the governed root, never by "is anything
 * above me also a repository". §4.7 draws the other edge of the same rule: a
 * repository binds at ITS ROOT only, never recursively into subprojects.
 *
 * The two edges are one contract with two directions, and a suite that only
 * builds fixtures at the top of a disposable directory measures neither: a
 * fixture with nothing above it satisfies "not nested" by construction, so
 * an enforcement layer that goes inert the moment anything encloses it looks
 * identical to one that does not. Every arm here therefore builds the
 * governed repository INSIDE another repository, which is the arrangement
 * the rule is about.
 *
 * Three rules shape what these arms read, inherited from the gate's other
 * end-to-end suite:
 *
 *   1. **Never git's exit status.** The harness skips a dangling extension
 *      link and still exits 0, so an exit code cannot tell "the gate allowed
 *      this" from "the gate never loaded". Each arm reads the gate's own
 *      evidence — its records, or the effect the guarded command did or did
 *      not land — and carries positive load evidence in the same assertion.
 *   2. **The class's identity comes from the runtime.** The gate class's
 *      category is imported from the module that owns the predicate, so a
 *      rename there moves these arms with it.
 *   3. **Nothing operational is ever a destination.** The runtime is COPIED
 *      into the fixture and the runs carry no state seam, so the runtime
 *      self-locates to the fixture's own repository and resolves that
 *      repository's disposable state root — the arrangement in which the
 *      governed root under measurement is the fixture and not this
 *      repository (§5.5).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	AUDIT_FILE_NAME,
	buildFixture,
	type Fixture,
	type GitRepo,
	type PiRunResult,
	readAuditLinesAt,
	readSessionEntries,
	removeFixture,
	runPi,
	type ScriptTurn,
} from "./harness/run-pi.ts";

interface AuditRecord {
	timestamp: string;
	category: string;
	action: string;
	arm: string;
	text: string;
	[key: string]: unknown;
}

interface ProtectedModule {
	PROTECTED_BRANCH_CATEGORY: string;
}

/**
 * The durable entry the runtime appends once per session — the read surface
 * a later reader has for what this session's runtime resolved.
 */
interface RegistrationEntry {
	customType: string;
	data: {
		repoRoot: string;
		stateRoot: string;
		seamActive: boolean;
		auditWritable: boolean;
	};
}

/** The gate class's own identity, read from the module that owns its predicate. */
async function gateCategory(): Promise<string> {
	const owner = (await import("../.pi/extensions/ghjig/protected.ts")) as unknown as ProtectedModule;
	return owner.PROTECTED_BRANCH_CATEGORY;
}

const GUARDED_CONTENT = "GHJIG_GUARDED_CONTENT_PROBE";
const guardedCommit = (marker: string): string => `git commit --allow-empty -m "docs: ${GUARDED_CONTENT} ${marker}"`;

const bash = (command: string): ScriptTurn => ({ kind: "toolCall", name: "bash", arguments: { command } });
const DONE: ScriptTurn = { kind: "text", text: "GHJIG_GATE_SCOPE_DONE" };

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

function repoOf(fixture: Fixture): GitRepo {
	const repo = fixture.gitRepo;
	assert.ok(repo !== undefined, "fixture was built without a git repository");
	return repo;
}

/**
 * Puts a git repository AROUND the fixture's governed repository.
 *
 * The enclosing repository is initialised with the fixture's own hermetic
 * git environment, so nothing about it is inherited from the host, and it
 * lives inside the fixture root, so `removeFixture` disposes of it with
 * everything else (§4.7, §3.12).
 */
function encloseInAnotherRepository(fixture: Fixture): void {
	const repo = repoOf(fixture);
	repo.git(["init", "-q", "-b", "enclosing", fixture.root], fixture.root);
}

/** Records under the governed repository's own operational state root. */
function governedRecords(fixture: Fixture): AuditRecord[] {
	return readAuditLinesAt(join(fixture.projectDir, ".ghjig", "state", AUDIT_FILE_NAME)).map(
		(line) => JSON.parse(line) as AuditRecord,
	);
}

async function gateRecords(fixture: Fixture, action: string): Promise<AuditRecord[]> {
	const category = await gateCategory();
	return governedRecords(fixture).filter((record) => record.category === category && record.action === action);
}

function registrationEntries(fixture: Fixture): RegistrationEntry[] {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === "ghjig-registration",
	) as unknown as RegistrationEntry[];
}

/** The runtime registered itself in this session — "something ran at all". */
function runtimeLoaded(fixture: Fixture): boolean {
	return registrationEntries(fixture).length === 1;
}

/** Commits reachable from HEAD — the effect a blocked commit must not have landed. */
function commitCount(repo: GitRepo): number {
	return Number(repo.git(["rev-list", "--count", "HEAD"]));
}

let nestedDefaultFixture: Fixture;
let nestedDefaultRun: PiRunResult;
let nestedTopicFixture: Fixture;
let nestedTopicRun: PiRunResult;

before(async () => {
	// Run 1 — a governed repository nested inside another repository, with the
	// session sitting on the default branch. Both guarded actions are
	// presented in one session, because they are one scope question.
	nestedDefaultFixture = buildFixture({
		script: [bash(guardedCommit("nested-default")), bash("git push origin main"), DONE],
		gitRepo: { localOrigin: true },
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	encloseInAnotherRepository(nestedDefaultFixture);
	nestedDefaultRun = await runPi(nestedDefaultFixture, {
		seamUnset: true,
		env: repoOf(nestedDefaultFixture).env,
	});

	// Run 2 — the same arrangement, one branch over: the false-block edge. A
	// scope rule that widens far enough to see the nested repository must not
	// widen into refusing the work that repository is for.
	nestedTopicFixture = buildFixture({
		script: [bash(guardedCommit("nested-topic")), bash("git push origin topic"), DONE],
		gitRepo: { localOrigin: true },
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	encloseInAnotherRepository(nestedTopicFixture);
	repoOf(nestedTopicFixture).switchToNewBranch("topic");
	nestedTopicRun = await runPi(nestedTopicFixture, { seamUnset: true, env: repoOf(nestedTopicFixture).env });
});

after(() => {
	for (const fixture of [nestedDefaultFixture, nestedTopicFixture].filter((built) => built !== undefined)) {
		removeFixture(fixture);
	}
});

describe("AC1: a governed repository nested inside another repository is still governed (§4.6)", () => {
	it("the commit at the default branch never lands, in a session the runtime was live in", () => {
		// The effect and the load evidence together: a session that died before
		// the runtime registered would also leave the seed commit alone, and
		// that is not this gate working.
		assert.ok(
			commitCount(repoOf(nestedDefaultFixture)) === 1 && runtimeLoaded(nestedDefaultFixture),
			diagnostics(nestedDefaultRun),
		);
	});

	it("the push at the default branch reaches nothing on the remote", () => {
		// Measured at the remote itself: the fixture's origin is a real
		// repository inside the fixture, and it holds no ref unless a push
		// actually landed.
		assert.ok(
			repoOf(nestedDefaultFixture).git(["ls-remote", "origin"]) === "" && runtimeLoaded(nestedDefaultFixture),
			diagnostics(nestedDefaultRun),
		);
	});

	it("records one block for each guarded action, under the governed repository's own state root", async () => {
		// The decision has to be on the record, not merely absent in its effect:
		// an enforcement layer that goes inert leaves the same untouched
		// repository behind as one that blocked, and only a record tells them
		// apart (§3.8, §3.12).
		assert.equal(
			(await gateRecords(nestedDefaultFixture, "block")).length,
			2,
			`records: ${JSON.stringify(governedRecords(nestedDefaultFixture))}`,
		);
	});
});

describe("AC2: the nested arrangement does not refuse the work the repository is for (§3.6)", () => {
	it("the commit on a topic branch lands, in a session the runtime was live in", () => {
		assert.ok(
			commitCount(repoOf(nestedTopicFixture)) === 2 && runtimeLoaded(nestedTopicFixture),
			diagnostics(nestedTopicRun),
		);
	});

	it("the push of that topic branch reaches the remote", () => {
		assert.ok(
			/refs\/heads\/topic/.test(repoOf(nestedTopicFixture).git(["ls-remote", "origin"])) &&
				runtimeLoaded(nestedTopicFixture),
			diagnostics(nestedTopicRun),
		);
	});
});

