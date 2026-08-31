/**
 * What a bare push lands on when the configuration names it by upstream
 * (issue #33, AC1, AC2; §3.9, §3.11).
 *
 * A bare `git push` takes its destination from configuration, and the
 * configured modes do not all answer the same question. Under `simple` and
 * `current` the destination is the branch HEAD names, so resolving through
 * HEAD is the destination. Under `upstream` — and its accepted synonym
 * `tracking` — the destination is the branch this one is configured to
 * integrate with, whose NAME MAY DIFFER from HEAD's. A topic branch tracking
 * the repository's default branch is the ordinary shape of that difference,
 * and it is the shape in which resolving through HEAD answers "a topic
 * branch" about a push that lands on the default one.
 *
 * That is the wrong-allow direction §3.9 exists to close, so the arms here
 * pin both ends:
 *
 *   - the **floor** — a bare push whose upstream IS the default branch is
 *     not approved, under either spelling of the mode;
 *   - the **ceiling** — a bare push whose upstream is another topic branch
 *     stays approved, so closing the floor does not refuse the ordinary
 *     topic-branch push the same configuration produces.
 *
 * The fixture is oracled against real git before the gate is asked anything.
 * A reproduction that nobody calibrated is a claim about the fixture rather
 * than about the gate: `git push --dry-run --porcelain` reports the
 * destination ref it would write, without writing it, and the calibration
 * arm reads that destination out of git itself. The remote is a real bare
 * repository inside the fixture, so the dry run resolves locally and no
 * network is anywhere in the arrangement (§4.7, §3.12).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFixture, type Fixture, type GitRepo, removeFixture, withRepoGitAmbient } from "./harness/run-pi.ts";

interface GateVerdict {
	decision: "allow" | "block" | "refuse";
	arm: string;
	message: string;
}
interface GateModule {
	decideCommand(input: { cwd: string; command: string }): GateVerdict;
}

const BARE_PUSH = "git push";

interface Upstream {
	fixture: Fixture;
	repo: GitRepo;
	/** The branch the session sits on. */
	branch: string;
	/** The branch `@{upstream}` names for it — where a bare push lands. */
	upstream: string;
}

/**
 * A repository sitting on `branch`, configured to push by upstream, whose
 * upstream is `upstream`.
 *
 * The upstream is written as the two configuration keys git reads for it,
 * rather than through a porcelain command, so the fixture states the
 * arrangement it means instead of depending on which porcelain spelling this
 * git version accepts.
 */
function repositoryPushingByUpstream(mode: string, branch: string, upstream: string): Upstream {
	const fixture = buildFixture({ script: [], gitRepo: { localOrigin: true, localPushDefault: mode } });
	const repo = fixture.gitRepo;
	assert.ok(repo !== undefined, "fixture was built without a git repository");
	if (upstream !== repo.defaultBranch) {
		repo.git(["branch", upstream]);
		repo.git(["update-ref", `refs/remotes/origin/${upstream}`, repo.git(["rev-parse", upstream])]);
	}
	repo.switchToNewBranch(branch);
	repo.git(["config", `branch.${branch}.remote`, "origin"]);
	repo.git(["config", `branch.${branch}.merge`, `refs/heads/${upstream}`]);
	return { fixture, repo, branch, upstream };
}

/** The destination ref real git reports for a bare push, without performing one. */
function destinationRealGitReports(built: Upstream): string {
	return built.repo.git(["push", "--dry-run", "--porcelain"]);
}

async function decide(built: Upstream, command: string): Promise<GateVerdict> {
	const { decideCommand } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
	return withRepoGitAmbient(built.repo, () => decideCommand({ cwd: built.repo.root, command }));
}

let upstreamIsTheDefaultBranch: Upstream;
let trackingIsTheDefaultBranch: Upstream;
let upstreamIsAnotherTopicBranch: Upstream;

before(() => {
	upstreamIsTheDefaultBranch = repositoryPushingByUpstream("upstream", "topic", "main");
	trackingIsTheDefaultBranch = repositoryPushingByUpstream("tracking", "topic", "main");
	upstreamIsAnotherTopicBranch = repositoryPushingByUpstream("upstream", "topic", "integration");
});

after(() => {
	for (const built of [upstreamIsTheDefaultBranch, trackingIsTheDefaultBranch, upstreamIsAnotherTopicBranch]) {
		if (built !== undefined) {
			removeFixture(built.fixture);
		}
	}
});

describe("calibration: the fixture really does push a topic branch onto the default one", () => {
	it("real git reports the default branch as the destination of a bare push", () => {
		// The oracle, read before the gate is asked anything. Without it, a
		// non-approval below could be the gate refusing a fixture that never
		// reproduced the situation — a green for the wrong reason (§3.12).
		const repo = upstreamIsTheDefaultBranch.repo;
		assert.match(
			destinationRealGitReports(upstreamIsTheDefaultBranch),
			new RegExp(`:refs/heads/${repo.defaultBranch}(\\s|$)`, "m"),
			`git reported: ${destinationRealGitReports(upstreamIsTheDefaultBranch)}`,
		);
	});

	it("and the branch the session sits on is not that branch", () => {
		// The premise the whole block rests on: HEAD and the destination are two
		// different names here, which is the only arrangement in which resolving
		// through HEAD can answer about the wrong branch.
		const repo = upstreamIsTheDefaultBranch.repo;
		assert.notEqual(repo.git(["rev-parse", "--abbrev-ref", "HEAD"]), repo.defaultBranch);
	});
});

describe("a bare push that lands on the default branch is not approved, whatever the mode is called (§3.9)", () => {
	it("under push.default = upstream", async () => {
		const verdict = await decide(upstreamIsTheDefaultBranch, BARE_PUSH);
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("under push.default = tracking, the same mode under its other name", async () => {
		// The synonym is not a second rule: a repository that spells the mode
		// the older way configures the same push, so a reading that handles one
		// spelling and not the other leaves the class half-covered.
		const verdict = await decide(trackingIsTheDefaultBranch, BARE_PUSH);
		assert.notEqual(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});

describe("the ceiling: an upstream that is not the default branch stays approved (§3.6)", () => {
	it("calibration — real git reports that other branch as the destination", () => {
		assert.match(
			destinationRealGitReports(upstreamIsAnotherTopicBranch),
			new RegExp(`:refs/heads/${upstreamIsAnotherTopicBranch.upstream}(\\s|$)`, "m"),
			`git reported: ${destinationRealGitReports(upstreamIsAnotherTopicBranch)}`,
		);
	});

	it("the bare push is allowed", async () => {
		// The false-block edge of the same repair: reading the upstream is what
		// closes the floor, and reading it must not turn every upstream-mode
		// push into a refusal.
		const verdict = await decide(upstreamIsAnotherTopicBranch, BARE_PUSH);
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});
