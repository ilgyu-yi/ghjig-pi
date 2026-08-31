/**
 * A configuration construct the reader does not model (issue #33, AC1, AC2;
 * §3.6, §3.9, §3.11).
 *
 * What a bare `git push` lands on is decided by the effective
 * `push.default`, and the gate resolves that by reading configuration FILES
 * — no subprocess, so nothing it stands on can be redirected by whatever a
 * spawned program would resolve differently. Reading files is the right
 * mechanism. Modelling git's whole precedence chain from those files is the
 * part that does not terminate: git assembles that value from includes,
 * conditional includes, header spellings and an ambient key/value channel,
 * and every round of enumerating one more of them leaves the next one
 * silently unread.
 *
 * The invariant, the configuration half of the same fold
 * `reading-fold.unit.test.ts` pins for commands:
 *
 *   > Where the effective value is carried by a construct this reader does
 *   > not model, the construct is DETECTED, and a bare push it could route
 *   > is not approved. The reader never treats "I saw no value here" as "no
 *   > value is set".
 *
 *   The wrong-allow direction is exact and silent: the reader walks the files
 *   it knows, finds no `push.default`, falls back to git's built-in `simple`,
 *   resolves through HEAD, sees a topic branch, and approves — while the git
 *   that would actually run has `matching` in effect and pushes the default
 *   branch. Nothing about that verdict looks degraded.
 *
 * The floor is stated as NON-APPROVAL and never as a resolved value. Two
 * repairs satisfy it — following the construct and resolving correctly (a
 * block, since `matching` lands on the default branch), or detecting the
 * construct and refusing — and the contract is that the reader stops being
 * silently wrong, not that it picks one of them. An arm that demanded a
 * particular resolved value would decide that question here instead of where
 * it belongs.
 *
 * Every case is ORACLED AGAINST REAL GIT before the gate is asked anything.
 * A reproduction nobody calibrated is a claim about the fixture rather than
 * about the reader: `git config --get --includes push.default` reports the
 * value the git that would run has in effect, and the calibration arms read
 * it out of git itself (§3.12). Every file the arrangement touches sits
 * inside the fixture, and every git invocation runs with the fixture's own
 * global config and identity, so no host configuration is an input and none
 * is a destination (§4.7).
 *
 * The ceiling is the whole cost of the change and sits in this same file:
 * ordinary repositories, whose configuration carries none of these
 * constructs, must still be decided rather than refused — this class has no
 * in-session escape (§3.8), so a bare push refused here costs a trip outside
 * the session.
 */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The mode under test. `matching` pushes every branch that already exists on
 * the remote under the same name, the repository's default branch among them,
 * so a session on a topic branch performs a protected-ref push without ever
 * naming one — the destination is nowhere in the command string.
 */
const CARRIED_MODE = "matching";

/** The branch every arrangement below sits on — never the default branch. */
const SESSION_BRANCH = "topic";

/**
 * The ambient key/value channel, as git names it. Held as one record so the
 * arms that set it and the arms that clear it read the same three names.
 */
const AMBIENT_CONFIG_CHANNEL: Record<string, string> = {
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "push.default",
	GIT_CONFIG_VALUE_0: CARRIED_MODE,
};

interface Arrangement {
	fixture: Fixture;
	repo: GitRepo;
}

/**
 * A repository on a topic branch whose upstream is the default branch, with
 * `push.default` written NOWHERE the reader currently walks — the construct
 * `install` chooses is the only thing carrying it.
 *
 * The upstream is written as the two configuration keys git reads for it, so
 * the fixture states the arrangement it means rather than depending on which
 * porcelain spelling this git version accepts.
 */
function repositoryCarryingTheMode(install: (arrangement: Arrangement) => void): Arrangement {
	const fixture = buildFixture({ script: [], gitRepo: { localOrigin: true } });
	const repo = fixture.gitRepo;
	assert.ok(repo !== undefined, "fixture was built without a git repository");
	repo.switchToNewBranch(SESSION_BRANCH);
	repo.git(["config", `branch.${SESSION_BRANCH}.remote`, "origin"]);
	repo.git(["config", `branch.${SESSION_BRANCH}.merge`, `refs/heads/${repo.defaultBranch}`]);
	const arrangement = { fixture, repo };
	install(arrangement);
	return arrangement;
}

/** Writes a fixture-owned file carrying the mode, and returns its path. */
function fileCarryingTheMode(arrangement: Arrangement, name: string): string {
	const path = join(arrangement.fixture.root, name);
	writeFileSync(path, `[push]\n\tdefault = ${CARRIED_MODE}\n`);
	return path;
}

/** The repository's own configuration file — where a local construct is written. */
function repositoryConfigFile(repo: GitRepo): string {
	return join(repo.gitDir, "config");
}

/**
 * The four constructs, each installed so that the mode is reachable through
 * IT and through nothing else.
 *
 * They are four different mechanisms, not four spellings of one: an
 * unconditional include, a conditional include keyed on the git directory, a
 * value sharing a line with its section header, and the ambient key/value
 * channel that needs no file at all. A reader repaired for one of them is
 * still blind to the other three, which is the shape of the finding this file
 * exists to close.
 */
const constructs: Record<string, (arrangement: Arrangement) => void> = {
	"an unconditional include": ({ fixture, repo }) => {
		const carrier = fileCarryingTheMode({ fixture, repo }, "carried-by-include.gitconfig");
		appendFileSync(repositoryConfigFile(repo), `[include]\n\tpath = ${carrier}\n`);
	},
	"a conditional include keyed on the git directory": ({ fixture, repo }) => {
		const carrier = fileCarryingTheMode({ fixture, repo }, "carried-by-include-if.gitconfig");
		// The condition is written against the git directory as the FILESYSTEM
		// resolves it, because that is what git matches the pattern against; a
		// spelling that reaches the same directory through a link matches
		// nothing, and the calibration arm below is what would catch that.
		writeFileSync(
			repo.globalConfigFile,
			`[includeIf "gitdir:${realpathSync(repo.gitDir)}"]\n\tpath = ${carrier}\n`,
		);
	},
	"a value sharing a line with its section header": ({ repo }) => {
		appendFileSync(repositoryConfigFile(repo), `[push] default = ${CARRIED_MODE}\n`);
	},
	"the ambient key/value channel": ({ repo }) => {
		Object.assign(repo.env, AMBIENT_CONFIG_CHANNEL);
	},
};

const arrangements = new Map<string, Arrangement>();

/** An ordinary repository: no construct anywhere, the mode written the plain way. */
let ordinaryRepository: Arrangement;
/** An ordinary repository whose configuration says nothing about pushing at all. */
let unconfiguredRepository: Arrangement;

before(() => {
	for (const [described, install] of Object.entries(constructs)) {
		arrangements.set(described, repositoryCarryingTheMode(install));
	}
	unconfiguredRepository = repositoryCarryingTheMode(() => {});
	ordinaryRepository = repositoryCarryingTheMode(({ repo }) => {
		// The plain multi-line spelling of a mode the reader already models, in
		// the repository's own file: the ceiling's control. Detection must key
		// on the CONSTRUCT, not on the presence of a `[push]` section.
		appendFileSync(repositoryConfigFile(repo), "[push]\n\tdefault = simple\n");
	});
});

after(() => {
	for (const arrangement of arrangements.values()) {
		removeFixture(arrangement.fixture);
	}
	for (const arrangement of [ordinaryRepository, unconfiguredRepository]) {
		if (arrangement !== undefined) {
			removeFixture(arrangement.fixture);
		}
	}
});

function arrangementFor(described: string): Arrangement {
	const arrangement = arrangements.get(described);
	assert.ok(arrangement !== undefined, `no arrangement was built for ${described}`);
	return arrangement;
}

/** What real git has in effect for `push.default` in this arrangement. */
function modeRealGitReports(arrangement: Arrangement): string {
	return arrangement.repo.tryGit(["config", "--get", "--includes", "push.default"]).stdout;
}

/**
 * The composed verdict for `command` in this arrangement.
 *
 * The process's git ambient is pinned to the fixture's own files, and where
 * the arrangement's construct IS the ambient channel it is re-established
 * inside that pinning and torn down afterwards — the harness's pinning clears
 * exactly the variables the host might have set, which is the same set this
 * arrangement needs to occupy on purpose.
 */
async function decide(arrangement: Arrangement, command: string): Promise<GateVerdict> {
	const { decideCommand } = (await import("../.pi/extensions/ghjig/gate.ts")) as unknown as GateModule;
	const repo = arrangement.repo;
	return withRepoGitAmbient(repo, () => {
		const saved: Record<string, string | undefined> = {};
		for (const name of Object.keys(AMBIENT_CONFIG_CHANNEL)) {
			saved[name] = process.env[name];
			if (repo.env[name] !== undefined) {
				process.env[name] = repo.env[name];
			}
		}
		try {
			return decideCommand({ cwd: repo.root, command });
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});
}

describe("calibration: each construct really does put the mode in effect for real git", () => {
	it("the session sits on a topic branch, which is what makes a blind reader approve", () => {
		// The premise every floor arm rests on: HEAD does not name the default
		// branch, so a reader that misses the construct falls back to `simple`,
		// resolves through HEAD, and answers "a topic branch" about a push that
		// lands on the default one.
		const repo = arrangementFor("an unconditional include").repo;
		assert.deepEqual(
			{ head: repo.git(["rev-parse", "--abbrev-ref", "HEAD"]), isTheDefaultBranch: false },
			{ head: SESSION_BRANCH, isTheDefaultBranch: SESSION_BRANCH === repo.defaultBranch },
		);
	});

	for (const described of Object.keys(constructs)) {
		it(`real git reports "${CARRIED_MODE}" through ${described}`, () => {
			// Without this arm a non-approval below could be the gate refusing a
			// fixture that never reproduced the situation — a green for the wrong
			// reason (§3.12).
			assert.equal(modeRealGitReports(arrangementFor(described)), CARRIED_MODE);
		});
	}

	it("and no arrangement leaves the mode sitting where the reader already looks", () => {
		// "Reachable only through the construct" is the whole claim: the two
		// file-carried constructs put nothing in the repository's own config
		// text, and the ambient one puts nothing in any file. The one-line
		// header is deliberately excluded — its value IS in that file, and the
		// construct is the spelling the reader walks past.
		const carriedElsewhere = ["an unconditional include", "a conditional include keyed on the git directory"];
		assert.deepEqual(
			carriedElsewhere.map((described) =>
				readFileSync(repositoryConfigFile(arrangementFor(described).repo), "utf8").includes(CARRIED_MODE),
			),
			carriedElsewhere.map(() => false),
		);
	});
});

describe("a bare push routed by a construct the reader does not model is not approved (§3.9)", () => {
	for (const described of Object.keys(constructs)) {
		it(`${described}`, async () => {
			const verdict = await decide(arrangementFor(described), BARE_PUSH);
			assert.equal(verdict.decision === "allow", false, `verdict: ${JSON.stringify(verdict)}`);
		});
	}
});

describe("the ceiling: an ordinary configuration is still decided, not refused (§3.6)", () => {
	it("calibration — real git reports the plain mode for the ordinary repository", () => {
		assert.equal(modeRealGitReports(ordinaryRepository), "simple");
	});

	it("a bare push from a topic branch is allowed where the mode is written the plain way", async () => {
		// The false-block edge. Detecting the constructs must not turn every
		// repository that configures pushing into a refusal — there is no
		// in-session escape from this class, so a refusal here is a trip outside
		// the session for an ordinary topic-branch push.
		const verdict = await decide(ordinaryRepository, BARE_PUSH);
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});

	it("and where the configuration says nothing about pushing at all", async () => {
		// The commonest repository there is: no `push.default` anywhere, so
		// git's own built-in decides. A reader that refuses whenever it finds no
		// value has inverted the ceiling instead of closing the floor.
		const verdict = await decide(unconfiguredRepository, BARE_PUSH);
		assert.equal(verdict.decision, "allow", `verdict: ${JSON.stringify(verdict)}`);
	});
});
