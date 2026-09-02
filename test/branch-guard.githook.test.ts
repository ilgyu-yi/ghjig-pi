/**
 * Behavioral suite for the protected-branch class at the pre-push adapter
 * (issue #59 ACs; SPEC §3.3 ref-identity semantics, §3.9, §3.11).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/pre-push` + `.githooks/_lib.sh`, copied byte-for-byte into a
 * disposable git repository by `harness/githook-fixture.ts` and driven only
 * through `git push` against a fixture-local bare remote (the arms measure
 * the chain an operator runs, never a predicate called directly).
 *
 * ARMED-CHAIN ASSERTIONS. Every refuse- and record-shaped arm below asserts
 * the armed contract: while `.githooks/helpers/branch_guard.sh` is absent
 * from the tree, the chain falls through `githook_source`'s fail-open branch
 * to `exit 0` and every guarded push SUCCEEDS with no block record — those
 * arms are red by design until the helper lands (§1.2 failing-first). The
 * allow-shaped and degradation-shaped arms are boundary pins, green in BOTH
 * tree states: they pin the floor the fix must not break, never the fix.
 *
 * Environment constraints stated in place:
 *   - The protected identity uses a DISTINCTIVE branch name (never `main`):
 *     the content-free assertions check that the refname's bytes reach no
 *     refusal surface, and a common word would collide with incidental git
 *     output (paths, unrelated stderr) instead of measuring the chain.
 *   - The case-variant arm asserts on block-record presence and cause
 *     shape, NEVER on the push exit status: on a case-insensitive local
 *     filesystem the bare remote's own ref storage can reject the variant
 *     inside git itself, so the exit status does not separate the hook's
 *     refusal from the transport's.
 *   - The multi-ref arm's stdin shape is a constraint on git, stated at the
 *     arm: existing-ref updates reach pre-push stdin ordered by remote
 *     refname bytes (creations arrive after updates), so a companion ref
 *     that byte-sorts before the protected name puts the protected name
 *     beyond line 1 — the line a single-read adapter would never inspect.
 *   - Causes and audit records are compared by decimal-normalized shape,
 *     never by string: the helper is free to word its causes, but the
 *     ambiguous-destination refusal must stay distinguishable at the
 *     observable from the byte-equal refusal (§3.9).
 *   - `refs/remotes/origin/HEAD` is the derivation's stage-1 source; the
 *     fixture omits it (`omitHeadPointer`) for the stage-2 arms and dangles
 *     the remote's own HEAD (`danglingRemoteHead`) for the both-stages-fail
 *     arm, where `ls-remote --symref origin HEAD` yields empty output with
 *     exit 0.
 *   - POSIX bytes and bash are required throughout: the suite skips on
 *     win32.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	pushRefs,
	removeGithookFixture,
	seedLocalCommit,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";

/** The derived protected identity P — distinctive on purpose (header note). */
const PROTECTED = "zqtrunkzq";
/** ASCII-case-fold-equal to P, byte-unequal — the ambiguous destination. */
const PROTECTED_VARIANT = "ZQTRUNKZQ";
/** Byte-sorts before PROTECTED — holds stdin line 1 in the multi-ref arm. */
const COMPANION = "aacompanionzq";

/**
 * Decimal-normalized cause shape: two causes that differ only in a measured
 * number are the SAME shape (mirrors the sibling commit-format suite).
 */
function causeShape(cause: string): string {
	return cause.trim().replace(/\d+/g, "N");
}

/**
 * The refusal observable (§3.3 byte-equal arm): a block audit record naming
 * the branch class, the adapter's live recovery line on stderr, and — unless
 * the caller opts out (case-variant arm, header note) — a non-zero push.
 * While the helper is absent these arms fail HERE, at the record assertion:
 * the push falls through fail-open and appends no block record.
 */
function assertPushRefused(
	attempt: CommitAttempt,
	arm: string,
	opts: { checkExit?: boolean } = {},
): void {
	assert.match(
		attempt.auditDelta,
		/\bblock\b.*\bbranch\b/,
		`${arm}: no block record naming the branch class was appended — the push fell through the ` +
			`fail-open chain (red until .githooks/helpers/branch_guard.sh lands and is_protected_branch ` +
			`refuses this target); delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	if (opts.checkExit !== false) {
		assert.notEqual(attempt.status, 0, `${arm}: the guarded push SUCCEEDED through the chain`);
	}
	assert.match(
		attempt.stderr,
		/\[dev-shell\]/,
		`${arm}: the refusal reached the operator without the adapter's live recovery line (§3.11 arm-scoped remediation)`,
	);
}

/**
 * Content-free surfaces (§3.9): a refusal names its arm, never the actor's
 * refname bytes — neither on stderr nor in the audit record.
 */
function assertRefnameContentFree(attempt: CommitAttempt, refname: string, arm: string): void {
	const bytes = Buffer.from(refname, "utf8");
	assert.equal(
		attempt.stderrBytes.includes(bytes),
		false,
		`${arm}: the target refname's bytes reached stderr — causes are content-free constants (§3.9)`,
	);
	assert.equal(
		Buffer.from(attempt.auditDelta, "utf8").includes(bytes),
		false,
		`${arm}: the target refname's bytes reached the audit record — records are content-free (§3.9)`,
	);
}

/**
 * The ordinary-allow observable (§3.3 "anything else" arm): push succeeds,
 * no block record, no disarmed-gate ("not enforced") record. A
 * `helper-missing` warn from `safe_source`'s fail-open is OUT of this arm's
 * scope: it is the sourcing tier's own degradation record, present exactly
 * while the helper file is absent, and pinning total record silence would
 * falsely bind this boundary pin to one tree state.
 */
function assertPushAllowedOrdinarily(attempt: CommitAttempt, arm: string): void {
	assert.equal(attempt.status, 0, `${arm}: ${attempt.stderr}`);
	assert.doesNotMatch(
		attempt.auditDelta,
		/\bblock\b/,
		`${arm}: an ordinary allow appended a block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.equal(
		attempt.auditDelta.includes("not enforced"),
		false,
		`${arm}: an ordinary allow carried the disarmed-gate signal — the two allows must stay separable (§3.9)`,
	);
}

describe("pushes targeting the derived protected identity refuse (issue #59)", { skip: IS_WINDOWS }, () => {
	it("a push to the protected identity is refused, content-free", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assertPushRefused(attempt, "push to P");
			assertRefnameContentFree(attempt, PROTECTED, "push to P");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a deletion push of the protected identity is refused (the remote-ref column carries the real refname)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = pushRefs(fixture, [`:${PROTECTED}`]);
			assertPushRefused(attempt, "delete P");
			assertRefnameContentFree(attempt, PROTECTED, "delete P");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a multi-ref push carrying the protected identity beyond stdin line 1 is refused (the while-read loop is load-bearing)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			// Create the companion first — its target is not P, so this push is
			// allowed in both tree states and turns the guarded push below into
			// two EXISTING-ref updates, the shape whose stdin lines git orders
			// by remote refname bytes (header note): COMPANION on line 1, the
			// protected name beyond it.
			const companionCreate = pushRefs(fixture, [`${PROTECTED}:${COMPANION}`]);
			assert.equal(companionCreate.status, 0, companionCreate.stderr);
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [`${PROTECTED}:${COMPANION}`, PROTECTED]);
			assertPushRefused(attempt, "multi-ref with P beyond line 1");
			assertRefnameContentFree(attempt, PROTECTED, "multi-ref with P beyond line 1");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a force-push to the protected identity is refused by subsumption (the ref is protected; --force changes nothing)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED], { gitArgs: ["--force"] });
			assertPushRefused(attempt, "force-push to P");
			assertRefnameContentFree(attempt, PROTECTED, "force-push to P");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

describe("a case-variant of the protected identity refuses as ambiguous (issue #59, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let byteEqualRefusal: CommitAttempt;
	let variantRefusal: CommitAttempt;

	before(() => {
		fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		seedLocalCommit(fixture);
		byteEqualRefusal = pushRefs(fixture, [PROTECTED]);
		variantRefusal = pushRefs(fixture, [`${PROTECTED}:${PROTECTED_VARIANT}`]);
	});
	after(() => removeGithookFixture(fixture));

	it("the case-variant push lands a block record (exit status is not the observable — header note)", () => {
		assertPushRefused(variantRefusal, "case-variant of P", { checkExit: false });
	});

	it("the ambiguous-destination cause is distinct from the byte-equal cause", () => {
		// The refusal preconditions repeat on purpose: on a tree where the
		// pushes still fall through fail-open, git's own transport lines would
		// green a bare shape comparison vacuously.
		assertPushRefused(byteEqualRefusal, "push to P (reference refusal)");
		assertPushRefused(variantRefusal, "case-variant of P", { checkExit: false });
		assert.notEqual(variantRefusal.cause, "", "an ambiguity refusal owes its own cause line");
		assert.notEqual(
			causeShape(variantRefusal.cause),
			causeShape(byteEqualRefusal.cause),
			"the ambiguous-destination cause reuses the byte-equal shape — the two §3.3 arms must stay " +
				"distinguishable at the observable",
		);
	});

	it("neither spelling's bytes surface on the refusal record", () => {
		assertPushRefused(variantRefusal, "case-variant of P", { checkExit: false });
		assertRefnameContentFree(variantRefusal, PROTECTED_VARIANT, "case-variant of P");
		assertRefnameContentFree(variantRefusal, PROTECTED, "case-variant of P");
	});
});

describe("derivation of the protected identity (issue #59, SPEC §3.3 stage 2, §3.9)", { skip: IS_WINDOWS }, () => {
	it("pointer absent, remote reachable: stage 2 derives P and the push is still refused", () => {
		const fixture = buildGithookFixture({
			remote: { defaultBranch: PROTECTED, omitHeadPointer: true },
		});
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assertPushRefused(attempt, "stage-2 derivation");
			assertRefnameContentFree(attempt, PROTECTED, "stage-2 derivation");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("both stages fail: the push is allowed and ONE warn record says the gate is not enforced", () => {
		const fixture = buildGithookFixture({
			remote: { defaultBranch: PROTECTED, omitHeadPointer: true, danglingRemoteHead: true },
		});
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			// The allow itself holds in both tree states; the SIGNAL is what
			// separates this disarmed allow from an ordinary allow (§3.9's
			// degradation-signal rule) and is red until the helper lands.
			assert.equal(attempt.status, 0, `disarmed gate must fail open, never block: ${attempt.stderr}`);
			const notEnforced = attempt.auditDelta.split("\n").filter((line) => line.includes("not enforced"));
			assert.equal(
				notEnforced.length,
				1,
				`disarmed allow: expected exactly one audit record stating the gate is not enforced; ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.match(notEnforced[0], /\bwarn\b/, "the disarmed-gate record is a warn, never a block");
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`P underivable is machinery degradation, never a refusal of the actor's input (§3.9); ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

describe("boundary pins — green in both tree states (issue #59)", { skip: IS_WINDOWS }, () => {
	// Every arm here pins the floor the armed helper must not break: they
	// hold while `.githooks/helpers/branch_guard.sh` is absent (fail-open
	// chain) AND after it lands (the §3.3 allow/degradation dispositions).
	// None of them is a red-first claim.

	it("a feature-branch push is allowed with no block and no disarmed-gate record", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = pushRefs(fixture, [`${PROTECTED}:aafeaturezq`]);
			assertPushAllowedOrdinarily(attempt, "feature push");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a force-push to a feature ref is allowed (subsumption's other half)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = pushRefs(fixture, [`${PROTECTED}:aaforcedzq`], { gitArgs: ["--force"] });
			assertPushAllowedOrdinarily(attempt, "force-push to a feature ref");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a tag push is allowed: a non-branch ref arrives unstripped and can never equal a branch name", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["tag", "v1zq"]);
			const attempt = pushRefs(fixture, ["v1zq"]);
			assertPushAllowedOrdinarily(attempt, "tag push");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper file absent: the push no-ops open, even to the protected identity", () => {
		const fixture = buildGithookFixture({
			helpersRelative: "helpers-absent",
			remote: { defaultBranch: PROTECTED },
		});
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assert.equal(
				attempt.status,
				0,
				`an absent helper must degrade to allow, never to a false block (githook_source fail-open): ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper present without is_protected_branch: the push no-ops open via githook_require", () => {
		const fixture = buildGithookFixture({
			helpersRelative: "helpers-stub",
			remote: { defaultBranch: PROTECTED },
		});
		try {
			writeFileSync(
				join(fixture.helpersDir, "branch_guard.sh"),
				"# stub helper: sources cleanly, defines everything except the delegated function\nunrelated_helper_function() { :; }\n",
			);
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assert.equal(
				attempt.status,
				0,
				`a helper without the delegated function must degrade to allow via githook_require: ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("pre-commit stays inert: a commit on the protected branch itself succeeds while secret_scan.sh is absent", () => {
		// The arming boundary (§3.3 commit arm): while secret_scan.sh is
		// absent, pre-commit's three-function require chain exits open at
		// that source line, pinning that shipping branch_guard.sh alone arms
		// NO commit-side check. Once the helper ships, the chain is armed
		// and the OPPOSITE observable — this same commit refused — is pinned
		// by the secret-scan suite's commit-on-P arm; the absence of the
		// file is this arm's whole premise, so it holds vacuously then
		// (the detached-HEAD arm below states the symmetric guard).
		if (existsSync(join(repoRoot(), ".githooks", "helpers", "secret_scan.sh"))) {
			return;
		}
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = commitWithMessage(fixture, "chore: exercise the commit-side chain\n");
			assert.equal(attempt.status, 0, `pre-commit armed early — its require chain is unsatisfied: ${attempt.stderr}`);
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`an inert pre-commit appended a block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

describe("current_branch detached-HEAD contract (issue #59, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	it("on a detached HEAD, current_branch prints nothing and exits non-zero (direct source)", () => {
		// Direct-source is deliberate and stated: no live git call site
		// consumes current_branch by design — pre-commit's require chain
		// stays unsatisfied until secret_scan.sh lands (the boundary pin
		// above measures that), so no through-git surface can reach this
		// function yet. This arm activates when the helper file ships; until
		// then the absence of the file IS the current truth and the arm
		// holds vacuously in both tree states.
		const helperPath = join(repoRoot(), ".githooks", "helpers", "branch_guard.sh");
		if (!existsSync(helperPath)) {
			return;
		}
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "--detach"]);
			const probe = spawnSync(
				"bash",
				[
					"-c",
					'set -u; . "$1" || exit 97; _gb_out="$(current_branch)"; _gb_rc=$?; printf \'%s\' "$_gb_out"; exit "$_gb_rc"',
					"bash",
					helperPath,
				],
				{
					cwd: fixture.root,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: join(fixture.root, "home"),
						GIT_CONFIG_NOSYSTEM: "1",
					},
				},
			);
			assert.notEqual(probe.status, 97, "branch_guard.sh failed to source in isolation");
			assert.notEqual(
				probe.status,
				0,
				"current_branch claimed success on a detached HEAD — a total function owes the failure outcome (§3.9)",
			);
			assert.equal(
				(probe.stdout ?? Buffer.alloc(0)).toString("utf8"),
				"",
				"current_branch printed output on a detached HEAD — no consumer may read an unvalidated value (§3.9)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
