/**
 * Behavioral suite for the commit-format class at the commit-msg adapter
 * (issue #55 ACs; SPEC §3.3 `commit-format` row, §3.9, §3.11).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/commit-msg` + `.githooks/_lib.sh`, copied byte-for-byte into a
 * disposable git repository by `harness/githook-fixture.ts` and driven only
 * through `git commit` (AC11: the arms measure the chain an operator runs,
 * never a predicate called directly).
 *
 * ARMED-CHAIN ASSERTIONS. Every refuse-shaped arm below asserts the armed
 * contract: while `.githooks/helpers/conventional_commit.sh` is absent from
 * the tree, the chain falls through `githook_source`'s fail-open branch to
 * `exit 0` and every guarded commit SUCCEEDS — those arms are red by
 * design until the helper lands (§1.2 failing-first). The allow-shaped and
 * degradation-shaped arms pass in both tree states: they pin the floor the
 * fix must not break, not the fix itself.
 *
 * Cause text is pinned by COMPARISON, never by string: the helper is free
 * to word its causes, but AC8 requires the unmeasurable outcome to be
 * distinguishable at the observable from an ordinary grammar refusal, an
 * ordinary length refusal, and an ordinary allow. The arms compare
 * decimal-normalized cause shapes across refusals in the same fixture, so
 * a cause that reuses another arm's template with a different number is
 * still caught (the false "out-of-range length" shape).
 *
 * Environment constraints stated in place:
 *   - The builder pins a multibyte-capable baseline locale (en_US.UTF-8);
 *     the degraded-measurement arms override it to the C charmap, in which
 *     a multibyte subject has no codepoint count and a naive byte length is
 *     a confident wrong decimal (§3.9's unmeasurable, environment shape).
 *   - The 0-codepoint arm commits with `--cleanup=verbatim`: git's default
 *     cleanup strips the subject's trailing space BEFORE the commit-msg
 *     hook fires, which would turn the 0-length subject into a grammar
 *     violation and measure the wrong arm.
 *   - ESC/CR/invalid-UTF-8 fixture bytes are built with String.fromCharCode,
 *     escape sequences, and Buffer, never as literal bytes in this source,
 *     so the file carries no raw control byte and no byte outside UTF-8.
 *   - POSIX bytes and bash are required throughout: the suite skips on
 *     win32.
 *
 * Residual, enumerated in place (§3.11: a gate names the vectors it
 * deliberately does not model): git also runs the commit-msg hook for the
 * commit `git merge` creates, and git's default merge message
 * ("Merge branch '<name>'") violates the grammar this tier holds, so an
 * armed tree refuses it with the same `--no-verify` recovery live. No arm
 * here forces a direction: the AC set governs commit subjects, and pinning
 * either the strict refusal or a merge-message carve-out would decide
 * contract the criteria do not cover. A later change that settles merge
 * messages owns its own arm.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";

const IS_WINDOWS = process.platform === "win32";

/** A grammar violation with nothing else at stake — the ordinary-refusal reference. */
const GRAMMAR_VIOLATION = "subject following no grammar at all\n";

/** The C-charmap environment: multibyte input has no codepoint count here. */
const BROKEN_LOCALE = { LANG: "C", LC_ALL: "C", LC_CTYPE: "C" } as const;

/**
 * Decimal-normalized cause shape: two causes that differ only in a measured
 * number are the SAME shape. Distinctness under this normalization is what
 * separates a genuinely different cause from another arm's template carrying
 * a different decimal.
 */
function causeShape(cause: string): string {
	return cause.trim().replace(/\d+/g, "N");
}

function assertRefusedThroughAdapter(attempt: CommitAttempt, arm: string): void {
	assert.notEqual(
		attempt.status,
		0,
		`${arm}: the commit SUCCEEDED — the chain fell through fail-open instead of refusing (red until ` +
			`.githooks/helpers/conventional_commit.sh lands and check_commit_subject refuses this subject)`,
	);
	assert.match(
		attempt.stderr,
		/--no-verify/,
		`${arm}: refusal reached the operator without the adapter's live recovery line (§3.11 arm-scoped remediation)`,
	);
}

describe("commit-format grammar and length at commit-msg (issue #55)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let grammarRefusal: CommitAttempt;
	let lengthRefusal: CommitAttempt;

	before(() => {
		fixture = buildGithookFixture();
		grammarRefusal = commitWithMessage(fixture, GRAMMAR_VIOLATION);
		lengthRefusal = commitWithMessage(fixture, `feat(#55): ${"x".repeat(73)}\n`);
	});
	after(() => removeGithookFixture(fixture));

	it("refuses a grammar-violating subject, with the tier's recovery appended", () => {
		assertRefusedThroughAdapter(grammarRefusal, "grammar violation");
	});

	it("a grammar refusal emits a non-empty predicate cause beside the recovery line", () => {
		assert.notEqual(
			grammarRefusal.cause,
			"",
			"no cause line reached stderr — the predicate owes the cause, the adapter owes only the recovery (§3.11)",
		);
	});

	it("a grammar refusal lands one block audit record naming the class", () => {
		assert.match(
			grammarRefusal.auditDelta,
			/\bblock\b.*commit-format/,
			`expected a block record naming commit-format; this attempt appended: ${JSON.stringify(grammarRefusal.auditDelta)}`,
		);
	});

	it("refuses a required-group subject missing its issue reference", () => {
		const attempt = commitWithMessage(fixture, "feat: subject with no issue reference\n");
		assertRefusedThroughAdapter(attempt, "required group without (#N)");
	});

	it("passes a conforming subject", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): add one conforming change\n");
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("a passing commit lands no block record", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): add another conforming change\n");
		assert.equal(attempt.status, 0, attempt.stderr);
		assert.doesNotMatch(attempt.auditDelta, /\bblock\b/, attempt.auditDelta);
	});

	it("passes a conforming subject carrying the breaking-change marker", () => {
		const attempt = commitWithMessage(fixture, "feat(#55)!: change a stated contract\n");
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("refuses a 73-codepoint subject", () => {
		assertRefusedThroughAdapter(lengthRefusal, "73 codepoints");
	});

	it("passes a 72-codepoint subject", () => {
		const attempt = commitWithMessage(fixture, `feat(#55): ${"x".repeat(72)}\n`);
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("passes a 1-codepoint subject", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): x\n");
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("refuses a 0-codepoint subject (verbatim cleanup keeps the separator's trailing space)", () => {
		// Default cleanup strips the trailing space before the hook fires and
		// this subject would land in the grammar arm instead of the 0-length
		// arm; a fully EMPTY message is out of reach by design — the adapter
		// fail-opens it to git's own empty-message handling.
		const attempt = commitWithMessage(fixture, "feat(#55): \n", { gitArgs: ["--cleanup=verbatim"] });
		assertRefusedThroughAdapter(attempt, "0 codepoints");
	});

	it("passes a 72-codepoint multibyte subject where a byte count would refuse", () => {
		// U+D55C x 72: 72 codepoints, 216 UTF-8 bytes — green only under
		// codepoint measurement.
		const attempt = commitWithMessage(fixture, `feat(#55): ${"\uD55C".repeat(72)}\n`);
		assert.equal(attempt.status, 0, attempt.stderr);
	});
});

describe("unmeasurable input refuses, distinctly (issue #55, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let grammarRefusal: CommitAttempt;
	let lengthRefusal: CommitAttempt;
	let environmentRefusal: CommitAttempt;
	let invalidByteRefusal: CommitAttempt;

	/** Grammar-conforming subject whose bytes are not valid UTF-8 (0xC3 0x28). */
	const invalidUtf8Message = Buffer.concat([
		Buffer.from("feat(#55): ab", "utf8"),
		Buffer.from([0xc3, 0x28]),
		Buffer.from("cd\n", "utf8"),
	]);

	before(() => {
		fixture = buildGithookFixture();
		grammarRefusal = commitWithMessage(fixture, GRAMMAR_VIOLATION);
		lengthRefusal = commitWithMessage(fixture, `feat(#55): ${"y".repeat(73)}\n`);
		// The environment arm is pinned to MULTIBYTE input: only a subject the
		// C charmap cannot measure separates unmeasurability detection from
		// plain byte-counting.
		environmentRefusal = commitWithMessage(fixture, `feat(#55): ${"\uD55C".repeat(8)}\n`, {
			env: { ...BROKEN_LOCALE },
		});
		invalidByteRefusal = commitWithMessage(fixture, invalidUtf8Message);
	});
	after(() => removeGithookFixture(fixture));

	it("a broken measurement environment with multibyte input yields the refuse observable", () => {
		assertRefusedThroughAdapter(environmentRefusal, "unmeasurable (environment shape)");
	});

	it("the environment-shape refusal is distinct from both the grammar cause and the length cause", () => {
		assert.notEqual(environmentRefusal.cause, "", "an unmeasurable refusal owes its own cause line");
		assert.notEqual(
			causeShape(environmentRefusal.cause),
			causeShape(grammarRefusal.cause),
			"the unmeasurable cause reuses the grammar-refusal shape — AC8 requires the three outcomes distinguishable",
		);
		assert.notEqual(
			causeShape(environmentRefusal.cause),
			causeShape(lengthRefusal.cause),
			"the unmeasurable cause reuses the length-refusal shape — a refusal that claims a length it never measured",
		);
	});

	it("the environment-shape refusal lands an audit record (distinct from an allow's silence)", () => {
		assert.match(environmentRefusal.auditDelta, /\bblock\b.*commit-format/, environmentRefusal.auditDelta);
	});

	it("a broken environment with pure-ASCII input still passes — degradation refuses only what it would mis-measure", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): plain ascii subject\n", {
			env: { ...BROKEN_LOCALE },
		});
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("invalid-UTF-8 subject bytes yield the refuse observable, never a silent pass", () => {
		assertRefusedThroughAdapter(invalidByteRefusal, "unmeasurable (input shape)");
	});

	it("the invalid-UTF-8 refusal never claims an out-of-range length", () => {
		// The refusal precondition repeats here on purpose: on a tree where the
		// commit still succeeds, git's own success-path encoding warning puts a
		// line on stderr and would green the shape comparison vacuously.
		assertRefusedThroughAdapter(invalidByteRefusal, "unmeasurable (input shape)");
		assert.notEqual(invalidByteRefusal.cause, "", "an unmeasurable refusal owes its own cause line");
		assert.notEqual(
			causeShape(invalidByteRefusal.cause),
			causeShape(lengthRefusal.cause),
			"the out-of-domain input drew the length-refusal cause — a naive count over invalid bytes is not a measurement (§3.9)",
		);
	});

	it("the invalid subject bytes never surface on stderr or in the audit record", () => {
		const invalidBytes = Buffer.from([0xc3, 0x28]);
		assert.equal(
			invalidByteRefusal.stderrBytes.includes(invalidBytes),
			false,
			"raw out-of-domain subject bytes reached stderr — causes are content-free (§3.9)",
		);
		assert.equal(
			Buffer.from(invalidByteRefusal.auditDelta, "utf8").includes(invalidBytes),
			false,
			"raw out-of-domain subject bytes reached the audit record — records are content-free (§3.9)",
		);
	});
});

describe("refusal surfaces are content-free (issue #55, SPEC §3.9, §3.11)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let hostileRefusal: CommitAttempt;

	const ESC = String.fromCharCode(27);
	const SENTINEL = "ZQSUBJECTSENTINELQZ";
	// A grammar-refused subject carrying ESC- and CR-adjacent hostile bytes:
	// any surface that echoes the subject would carry the sentinel and could
	// land control bytes on the operator's terminal or forge audit lines.
	const hostileSubject = `no grammar ${ESC}[31m${SENTINEL}\r tail\n`;

	before(() => {
		fixture = buildGithookFixture();
		hostileRefusal = commitWithMessage(fixture, hostileSubject);
	});
	after(() => removeGithookFixture(fixture));

	it("a hostile-byte subject is refused", () => {
		assertRefusedThroughAdapter(hostileRefusal, "hostile bytes");
	});

	it("no subject byte reaches stderr", () => {
		assert.equal(hostileRefusal.stderr.includes(SENTINEL), false, "subject text surfaced on stderr");
		assert.equal(hostileRefusal.stderr.includes(ESC), false, "a raw ESC byte surfaced on stderr");
	});

	it("no subject byte reaches the audit record", () => {
		assert.equal(hostileRefusal.auditDelta.includes(SENTINEL), false, "subject text reached the audit record");
		assert.equal(hostileRefusal.auditDelta.includes(ESC), false, "a raw ESC byte reached the audit record");
	});
});

describe("chain degradation stays fail-open (issue #55 AC9)", { skip: IS_WINDOWS }, () => {
	// Both arms construct their degradation deliberately and are green in
	// both tree states: they pin the fail-open floor (§3.9's machinery
	// carve-out), which the armed helper must not break.

	it("helper file absent: the hook no-ops and even a violating subject commits", () => {
		const fixture = buildGithookFixture({ helpersRelative: "helpers-absent" });
		try {
			const attempt = commitWithMessage(fixture, GRAMMAR_VIOLATION);
			assert.equal(
				attempt.status,
				0,
				`an absent helper must degrade to allow, never to a false block (githook_source fail-open): ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper present without check_commit_subject: the hook no-ops and even a violating subject commits", () => {
		const fixture = buildGithookFixture({ helpersRelative: "helpers-stub" });
		try {
			writeFileSync(
				join(fixture.helpersDir, "conventional_commit.sh"),
				"# stub helper: sources cleanly, defines everything except the delegated function\nunrelated_helper_function() { :; }\n",
			);
			const attempt = commitWithMessage(fixture, GRAMMAR_VIOLATION);
			assert.equal(
				attempt.status,
				0,
				`a helper without the delegated function must degrade to allow via githook_require: ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});
