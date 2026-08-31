/**
 * The protected-branch gate, end to end in real sessions (issue #33, AC1,
 * AC2, AC5, AC14).
 *
 * Every arm here drives an actual pi session through the hermetic harness:
 * scripted provider, explicit end-of-input, project-trust flag, placeholder
 * endpoint (§4.4). The session's working directory IS the fixture's git
 * repository, because that is the only layout in which the repository a
 * session acts on is the repository a gate measures.
 *
 * Four rules shape what the arms are allowed to read:
 *
 *   1. **Never git's exit status.** An extension the substrate does not find
 *      is not an error to it: the run proceeds and exits 0, so an exit code
 *      cannot tell "the gate allowed this" from "the gate never loaded".
 *      Every arm reads
 *      the gate's own evidence — its records, its message, or the effect the
 *      guarded command did or did not land — and the allow arms carry
 *      positive load evidence in the same block, so an empty false-block arm
 *      can never be an empty runtime.
 *   2. **The class's identity comes from the runtime.** The gate class's
 *      category is imported from the module that owns the predicate, so a
 *      rename there moves these arms with it instead of leaving them
 *      matching nothing. The one literal quoted from prose is the
 *      `/ghjig-topic` affordance, which SPEC §3.3 names in those words.
 *   3. **The runtime is installed the way an adopter installs it.** Every
 *      session here COPIES this repository's runtime into the fixture
 *      repository, so the module self-locates to the repository the session
 *      works in — one repository, governing itself, which is what a clone
 *      looks like. A runtime reached through a link self-locates to THIS
 *      repository while the session works in a temporary fixture, and that
 *      pairing corresponds to no installation anyone has: a suite built on it
 *      measures a scope reading no production session takes (§3.12). The one
 *      place a link survives is the interlock arm that exists to reject it.
 *   4. **Nothing operational is ever a destination.** Every run resolves its
 *      state to the fixture's own disposable seam target. This repository's
 *      state root is read before and after the suite and must be unchanged
 *      (§5.5).
 *
 * The record contract these arms read: every decision the gate records
 * carries the gate class as `category`, the decision as `action`, and the
 * deciding arm as `arm` — a decision is attributable, and an arm is named
 * rather than counted (§3.8).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	type GitRepo,
	listTreeEntries,
	type PiRunResult,
	readAuditLinesAt,
	readSessionEntries,
	removeFixture,
	repoRoot,
	runPi,
	type ScriptTurn,
	writeScript,
} from "./harness/run-pi.ts";

interface AuditRecord {
	timestamp: string;
	category: string;
	action: string;
	arm: string;
	text: string;
	[key: string]: unknown;
}

interface RegistrationEntry {
	customType: string;
	data: { repoRoot: string; stateRoot: string; seamActive: boolean; auditWritable: boolean };
}

interface ProtectedModule {
	PROTECTED_BRANCH_CATEGORY: string;
}

/** The gate class's own identity, read from the module that owns its predicate. */
async function gateCategory(): Promise<string> {
	const owner = (await import("../.pi/extensions/ghjig/protected.ts")) as unknown as ProtectedModule;
	return owner.PROTECTED_BRANCH_CATEGORY;
}

const GUARDED_CONTENT = "GHJIG_GUARDED_CONTENT_PROBE";
const guardedCommit = (marker: string): string => `git commit --allow-empty -m "docs: ${GUARDED_CONTENT} ${marker}"`;
const GUARDED_PUSH = "git push origin main";

const bash = (command: string): ScriptTurn => ({ kind: "toolCall", name: "bash", arguments: { command } });
const DONE: ScriptTurn = { kind: "text", text: "GHJIG_GATE_IT_DONE" };

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

function repoOf(fixture: Fixture): GitRepo {
	const repo = fixture.gitRepo;
	assert.ok(repo !== undefined, "fixture was built without a git repository");
	return repo;
}

/** Records under an arbitrary audit destination; empty when nothing was written. */
function recordsAt(auditFile: string): AuditRecord[] {
	return readAuditLinesAt(auditFile).map((line) => JSON.parse(line) as AuditRecord);
}

/** Records the run left under its own state root. */
function records(fixture: Fixture): AuditRecord[] {
	return recordsAt(fixture.auditFile);
}

function gateRecords(fixture: Fixture, category: string, action?: string): AuditRecord[] {
	return records(fixture).filter(
		(record) => record.category === category && (action === undefined || record.action === action),
	);
}

/** Every tool result the session recorded, in order, with the text the actor saw. */
function toolResults(fixture: Fixture): Array<{ isError: boolean; text: string }> {
	return readSessionEntries(fixture)
		.filter((entry) => {
			const message = entry.message as { role?: string } | undefined;
			return entry.type === "message" && message?.role === "toolResult";
		})
		.map((entry) => {
			const message = entry.message as {
				isError?: boolean;
				content?: Array<{ type: string; text?: string }>;
			};
			return {
				isError: message.isError === true,
				text: (message.content ?? [])
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n"),
			};
		});
}

/**
 * Positive load evidence, two strengths.
 *
 * `runtimeLoaded` says the runtime registered itself in this session, which
 * is what separates "the gate allowed this" from "nothing ran at all".
 * `gateDecided` says the gate examined something and wrote a decision down,
 * which is what an empty false-block arm needs: a runtime that loads but
 * never gates leaves the same zero blocks behind as one that gates
 * correctly, and only a decision on the record tells them apart (§3.12).
 */
function runtimeLoaded(fixture: Fixture): boolean {
	return registrationEntries(fixture).length === 1;
}

function gateDecided(fixture: Fixture, category: string): boolean {
	return gateRecords(fixture, category).length > 0;
}

function registrationEntries(fixture: Fixture): RegistrationEntry[] {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === "ghjig-registration",
	) as unknown as RegistrationEntry[];
}

/** Commits reachable from HEAD — the effect a blocked commit must not have landed. */
function commitCount(repo: GitRepo): number {
	return Number(repo.git(["rev-list", "--count", "HEAD"]));
}

/** A directory listing that reads absence as emptiness rather than as a throw. */
function listIfPresent(dir: string): string[] {
	return existsSync(dir) ? listTreeEntries(dir) : [];
}

/** This repository's own operational state root — read only, never a destination. */
const OPERATIONAL_STATE_ROOT = join(repoRoot(), ".ghjig", "state");

let operationalBefore: string[];

let blockCommitFixture: Fixture;
let blockCommitRun: PiRunResult;
let blockPushFixture: Fixture;
let blockPushRun: PiRunResult;
let allowFixture: Fixture;
let allowRun: PiRunResult;
let aliasFixture: Fixture;
let aliasRun: PiRunResult;
let refuseFixture: Fixture;
let refuseRun: PiRunResult;

const sharedFixtures = (): Fixture[] => [
	blockCommitFixture,
	blockPushFixture,
	allowFixture,
	aliasFixture,
	refuseFixture,
];

before(async () => {
	operationalBefore = listIfPresent(OPERATIONAL_STATE_ROOT);

	// Run 1 — a commit on the default branch, the plain spelling.
	blockCommitFixture = buildFixture({
		script: [bash(guardedCommit("plain")), DONE],
		gitRepo: {},
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	blockCommitRun = await runPi(blockCommitFixture, { env: repoOf(blockCommitFixture).env });

	// Run 2 — a push at the default branch, against a real (local) origin, so
	// "nothing was pushed" is a fact about the remote rather than about the
	// network.
	blockPushFixture = buildFixture({
		script: [bash(GUARDED_PUSH), DONE],
		gitRepo: { localOrigin: true },
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	blockPushRun = await runPi(blockPushFixture, { env: repoOf(blockPushFixture).env });

	// Run 3 — the same two actions on a topic branch: the false-block arm.
	allowFixture = buildFixture({
		script: [bash(guardedCommit("topic")), bash("git push origin topic"), DONE],
		gitRepo: { localOrigin: true },
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	repoOf(allowFixture).switchToNewBranch("topic");
	allowRun = await runPi(allowFixture, { env: repoOf(allowFixture).env });

	// Run 4 — the default branch reached through a second name. The symref
	// alias is the portable identity case: it is one ref by git's own
	// accounting on every filesystem, unlike a case variant, which is one ref
	// only where the filesystem folds case.
	aliasFixture = buildFixture({
		script: [bash(guardedCommit("alias")), DONE],
		gitRepo: {},
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	const alias = repoOf(aliasFixture);
	alias.addSymrefAlias("refs/heads/aka", `refs/heads/${alias.defaultBranch}`);
	alias.setHead("refs/heads/aka");
	aliasRun = await runPi(aliasFixture, { env: alias.env });

	// Run 5 — the pointer that says which branch is the default one is gone,
	// so the target cannot be measured at all.
	refuseFixture = buildFixture({
		script: [bash(guardedCommit("unmeasurable")), DONE],
		gitRepo: {},
		projectDir: "gitRepo",
		copyGhjigRuntime: true,
	});
	repoOf(refuseFixture).removeOriginHead();
	refuseRun = await runPi(refuseFixture, { env: repoOf(refuseFixture).env });
});

after(() => {
	// Filtered, so a fixture that was never reached cannot turn a real failure
	// in the setup into a cleanup error that hides it.
	for (const fixture of sharedFixtures().filter((built) => built !== undefined)) {
		removeFixture(fixture);
	}
});

describe("AC1: a commit at the default branch is blocked, with a reason and a record (§3.5)", () => {
	it("the commit never lands, in a session the runtime was live in", () => {
		// The effect and the load evidence together: a session that died before
		// the runtime registered would also leave the seed commit alone, and
		// that is not this gate working.
		assert.ok(
			commitCount(repoOf(blockCommitFixture)) === 1 && runtimeLoaded(blockCommitFixture),
			diagnostics(blockCommitRun),
		);
	});

	it("the actor is told, at the surface that refused", () => {
		// The refusal has to reach the caller: a gate that decides silently
		// converts blocked work into a mystery rather than into a next step.
		const blocked = toolResults(blockCommitFixture).filter((result) => result.isError);
		assert.equal(blocked.length, 1, `tool results: ${JSON.stringify(toolResults(blockCommitFixture))}`);
	});

	it("the reason names the compliant path — a topic branch, then a PR (§3.5)", () => {
		const [blocked] = toolResults(blockCommitFixture).filter((result) => result.isError);
		assert.ok(
			blocked !== undefined && /topic branch/i.test(blocked.text) && /\bPR\b|pull request/i.test(blocked.text),
			`the block reason must name the positive remediation; got ${JSON.stringify(blocked?.text)}`,
		);
	});

	it("the reason names the affordance that repairs it (§3.11)", () => {
		// §3.3 discharges the in-flow authoring-affordance obligation with
		// `/ghjig-topic`; a message naming no live affordance manufactures a
		// manual repair.
		const [blocked] = toolResults(blockCommitFixture).filter((result) => result.isError);
		assert.match(blocked?.text ?? "", /\/ghjig-topic/, diagnostics(blockCommitRun));
	});

	it("writes exactly one record for the block", async () => {
		const category = await gateCategory();
		assert.equal(
			gateRecords(blockCommitFixture, category, "block").length,
			1,
			`records: ${JSON.stringify(records(blockCommitFixture))}`,
		);
	});

	it("that record names the deciding arm", async () => {
		const category = await gateCategory();
		const [record] = gateRecords(blockCommitFixture, category, "block");
		assert.ok(
			typeof record?.arm === "string" && record.arm.trim() !== "" && !/^\d+$/.test(record.arm),
			`the block record must name its arm; got ${JSON.stringify(record)}`,
		);
	});

	it("that record carries no byte of the guarded content (§5.5)", async () => {
		const category = await gateCategory();
		const [record] = gateRecords(blockCommitFixture, category, "block");
		assert.equal(
			JSON.stringify(record ?? {}).includes(GUARDED_CONTENT),
			false,
			`records: ${JSON.stringify(records(blockCommitFixture))}`,
		);
	});
});

describe("AC1: a push at the default branch is blocked (§3.5)", () => {
	it("nothing reaches the remote, in a session the runtime was live in", () => {
		// Measured at the remote itself: the fixture's origin is a real
		// repository inside the fixture, and it has no refs unless a push
		// actually landed.
		assert.ok(
			repoOf(blockPushFixture).git(["ls-remote", "origin"]) === "" && runtimeLoaded(blockPushFixture),
			diagnostics(blockPushRun),
		);
	});

	it("writes exactly one record for the block", async () => {
		const category = await gateCategory();
		assert.equal(
			gateRecords(blockPushFixture, category, "block").length,
			1,
			`records: ${JSON.stringify(records(blockPushFixture))}`,
		);
	});
});

describe("AC2: the false-block arm is demonstrably empty on a topic branch (§3.6)", () => {
	// Every arm here carries its own positive load evidence, because every
	// one of them is satisfied by a runtime that never gated anything. An
	// emptiness measured in a session where the gate never decided is not an
	// empty false-block arm; it is an unmeasured one (§3.12).

	it("records no block at all, in a session the gate decided in", async () => {
		const category = await gateCategory();
		assert.ok(
			gateRecords(allowFixture, category, "block").length === 0 && gateDecided(allowFixture, category),
			`records: ${JSON.stringify(records(allowFixture))}`,
		);
	});

	it("records a named allow for each guarded action", async () => {
		// Two guarded actions were presented, so two allow decisions must be on
		// the record, each naming its arm — a decision the gate does not write
		// down is a decision no reader can distinguish from an absence.
		const category = await gateCategory();
		const allows = gateRecords(allowFixture, category, "allow");
		assert.ok(
			allows.length === 2 && allows.every((record) => typeof record.arm === "string" && record.arm.trim() !== ""),
			`expected two named allow records; got ${JSON.stringify(records(allowFixture))}`,
		);
	});

	it("the commit lands, with the gate's decision on the record", async () => {
		const category = await gateCategory();
		assert.ok(commitCount(repoOf(allowFixture)) === 2 && gateDecided(allowFixture, category), diagnostics(allowRun));
	});

	it("the push reaches the remote, with the gate's decision on the record", async () => {
		const category = await gateCategory();
		assert.ok(
			/refs\/heads\/topic/.test(repoOf(allowFixture).git(["ls-remote", "origin"])) &&
				gateDecided(allowFixture, category),
			diagnostics(allowRun),
		);
	});

	it("no tool call was interfered with, in a session the gate governed", async () => {
		const category = await gateCategory();
		assert.ok(
			toolResults(allowFixture).every((result) => result.isError === false) &&
				toolResults(allowFixture).length === 2 &&
				gateDecided(allowFixture, category),
			`tool results: ${JSON.stringify(toolResults(allowFixture))}`,
		);
	});
});

describe("AC3: a second spelling of the same ref blocks identically (§3.11)", () => {
	it("the commit on the aliased default branch never lands", () => {
		assert.ok(commitCount(repoOf(aliasFixture)) === 1 && runtimeLoaded(aliasFixture), diagnostics(aliasRun));
	});

	it("decides through the same arm as the plain spelling — one ref, one decision", async () => {
		const category = await gateCategory();
		const [aliased] = gateRecords(aliasFixture, category, "block");
		const [plain] = gateRecords(blockCommitFixture, category, "block");
		assert.ok(
			aliased !== undefined && plain !== undefined && aliased.arm === plain.arm,
			`the two spellings must decide through one arm; aliased=${JSON.stringify(aliased)} plain=${JSON.stringify(plain)}`,
		);
	});
});

describe("AC5: an unmeasurable target refuses, and says something else (§3.9, §3.11)", () => {
	it("the commit is not approved", () => {
		assert.ok(commitCount(repoOf(refuseFixture)) === 1 && runtimeLoaded(refuseFixture), diagnostics(refuseRun));
	});

	it("the refusal and the block are two different messages", () => {
		// §3.11: two failure shapes get two distinct messages — "the evidence
		// is missing" and "the lookup failed" have different remedies, and one
		// shared string would name the wrong one for half its readers.
		const [refused] = toolResults(refuseFixture).filter((result) => result.isError);
		const [blocked] = toolResults(blockCommitFixture).filter((result) => result.isError);
		assert.ok(
			refused !== undefined && blocked !== undefined && refused.text !== blocked.text,
			`refusal=${JSON.stringify(refused?.text)} block=${JSON.stringify(blocked?.text)}`,
		);
	});

	it("the refusal names the recovery that is live for it", () => {
		const [refused] = toolResults(refuseFixture).filter((result) => result.isError);
		assert.match(refused?.text ?? "", /git remote set-head origin --auto/, diagnostics(refuseRun));
	});

	it("the block names the recovery that is live for it", () => {
		const [blocked] = toolResults(blockCommitFixture).filter((result) => result.isError);
		assert.match(blocked?.text ?? "", /\/ghjig-topic/, diagnostics(blockCommitRun));
	});
});

describe("AC14: no ordering converts a block into an allow (§3.11)", () => {
	/**
	 * The property over the verdicts this gate has: allow is non-terminal,
	 * and block and refuse terminate. One session presents all three, in an
	 * order where the guarded action that blocks is presented once at the
	 * start and again at the end, with an allow and a refusal in between —
	 * so what the last decision reads is whether any earlier verdict carried
	 * forward into it.
	 *
	 * Between the guarded calls, the repository is moved by UNGUARDED
	 * commands only — a branch switch, and the removal and restoration of the
	 * remote pointer that names the default branch. Each guarded call
	 * therefore meets a state the one before it did not, without any step
	 * that changes the state being a guarded action itself.
	 *
	 * The script is written after the fixture, because the restoring step has
	 * to name the branch this repository calls its default.
	 */
	let orderFixture: Fixture;
	let orderRun: PiRunResult;

	before(async () => {
		orderFixture = buildFixture({
			script: [],
			gitRepo: {},
			projectDir: "gitRepo",
			copyGhjigRuntime: true,
		});
		const repo = repoOf(orderFixture);
		const originHead = "refs/remotes/origin/HEAD";
		writeScript(orderFixture, [
			bash("echo GHJIG_UNGUARDED_STEP"),
			bash(guardedCommit("at-the-default-branch")),
			bash(`git symbolic-ref -d ${originHead}`),
			bash(guardedCommit("with-an-unmeasurable-target")),
			bash(`git symbolic-ref ${originHead} refs/remotes/origin/${repo.defaultBranch}`),
			bash("git switch -q -c ordering-topic"),
			bash(guardedCommit("on-a-topic-branch")),
			bash("git switch -q -"),
			bash(guardedCommit("at-the-default-branch-again")),
			DONE,
		]);
		orderRun = await runPi(orderFixture, { env: repo.env });
	});

	after(() => removeFixture(orderFixture));

	it("the session really did present all three kinds of verdict", async () => {
		// The calibration the property needs: a permutation in which the gate
		// only ever allowed, or only ever blocked, pins nothing about ordering
		// (§3.12).
		const category = await gateCategory();
		const kinds = [...new Set(gateRecords(orderFixture, category).map((record) => record.action))].sort();
		assert.deepEqual(kinds, ["allow", "block", "refuse"], `records: ${JSON.stringify(records(orderFixture))}`);
	});

	it("exactly the one allowed commit lands", () => {
		// Four guarded commits were presented and one of them was on a topic
		// branch, so the seed commit and that one are the whole history.
		// Counted over every ref rather than from HEAD, because the session
		// switched back off the branch the allowed commit landed on.
		const reachable = Number(repoOf(orderFixture).git(["rev-list", "--count", "--all"]));
		assert.ok(reachable === 2 && runtimeLoaded(orderFixture), diagnostics(orderRun));
	});

	it("the guarded action that blocked first still blocks last", async () => {
		const category = await gateCategory();
		const decisions = gateRecords(orderFixture, category).map((record) => record.action);
		assert.equal(decisions.at(-1), "block", `decisions: ${JSON.stringify(decisions)}`);
	});

	it("no allow in the session was ever taken about the default branch", async () => {
		// The property stated as the outcome it forbids. Read as the SET of
		// arms that allowed, so it pins which decisions were allows rather than
		// how many commands the permutation happened to contain: the unguarded
		// steps land on no ref, and the one guarded allow is the topic branch.
		const category = await gateCategory();
		const arms = [...new Set(gateRecords(orderFixture, category, "allow").map((record) => record.arm))].sort();
		assert.deepEqual(arms, ["not-a-git-command", "topic-branch"], `records: ${JSON.stringify(records(orderFixture))}`);
	});
});

describe("D2: the suite writes no operational state of this repository (§5.5)", () => {
	it("leaves this repository's state root exactly as it found it", () => {
		// Stated as a before/after invariant rather than as absence: the gate
		// this issue lands is the first operational writer, so a working clone
		// legitimately has this directory, and an absence assertion would be a
		// red that is not a defect (§3.12).
		assert.deepEqual(listIfPresent(OPERATIONAL_STATE_ROOT), operationalBefore);
	});

	it("the harness refuses the one combination that would write it", () => {
		// The invariant above is an outcome; this is the interlock that makes
		// the outcome structural. An unseamed run resolves the state root from
		// the runtime's own location, so combining it with a runtime linked
		// out of this repository is the single arrangement in which a suite
		// writes the operational sink — and the harness rejects it rather than
		// naming it a caller precondition.
		const linked = buildFixture({ script: [], linkGhjigRuntime: true });
		try {
			assert.throws(() => void runPi(linked, { seamUnset: true }), /operational sink/);
		} finally {
			removeFixture(linked);
		}
	});
});
