/**
 * Behavioral suite for the staged-secret class and the protected-branch
 * commit arm at the pre-commit adapter (issue #66 ACs; SPEC §3.3
 * staged-scan semantics + ref-identity semantics, §3.8, §3.9, §3.10).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/pre-commit` + `.githooks/_lib.sh`, copied byte-for-byte into a
 * disposable git repository by `harness/githook-fixture.ts` and driven only
 * through `git commit` (the arms measure the chain an operator runs, never
 * a predicate called directly).
 *
 * ARMED-CHAIN ASSERTIONS. Every refuse- and record-shaped arm asserts the
 * armed contract: while `.githooks/helpers/secret_scan.sh` is absent from
 * the tree, `pre-commit`'s require chain falls through `githook_source`'s
 * fail-open branch to `exit 0` and every guarded commit SUCCEEDS with no
 * block record — those arms are red by design until the helper lands (§1.2
 * failing-first). Allow-shaped and no-op arms are boundary pins, green in
 * BOTH tree states; each declares itself one.
 *
 * Environment constraints stated in place:
 *   - Every planted secret and every hostile byte is BUILT AT RUNTIME from
 *     codepoint constants and concatenation, never written literally: a
 *     literal secret-shaped string in this source would trip the
 *     development shell's own staged-secret matcher the moment this file
 *     is committed (the measured hazard), and later this repository's own
 *     armed hook. The construction also keeps the byte-absence assertions
 *     honest — the asserted sequence exists only at runtime.
 *   - Pattern-file substrate, stated per arm and summarized here: the
 *     committed pattern file (`.githooks/helpers/secret-patterns`) ships
 *     with its scanner, so scan-shaped arms that need patterns author the
 *     PLANNED rows into the FIXTURE's copy only while the committed file
 *     is absent (`ensurePlannedPatterns`); once the file ships, those arms
 *     measure the committed bytes, so a dropped committed row reddens its
 *     own refusal arm (§3.12). Machinery arms author their own degenerate
 *     fixture-local pattern files unconditionally — their contract IS the
 *     degenerate file. The committed-file pins at the bottom assert
 *     against the repository path itself and are red until the file lands.
 *   - The protected identity and every content marker use DISTINCTIVE
 *     spellings (`zq…`): byte-level "these bytes reached no surface"
 *     assertions must not collide with incidental git output.
 *   - Where two refusal causes must stay distinguishable, the staged
 *     filenames differ only in a decimal digit and comparisons use
 *     decimal-normalized cause shapes, so path spelling cannot green the
 *     distinctness vacuously.
 *   - POSIX bytes and bash are required throughout: the suite skips on
 *     win32. The unreadable-allow-list arm additionally skips for root,
 *     for whom mode 000 denies nothing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	fixtureGit,
	removeDelegatedHelpers,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const cp = String.fromCharCode;

/** The derived protected identity P — distinctive on purpose (header note). */
const PROTECTED = "zqcommittrunkzq";
/** The ordinary working branch for scan-shaped arms. */
const FEATURE = "zqfeaturezq";

// ---------------------------------------------------------------------------
// Runtime-built secret material (header note: never literal in source).
// ---------------------------------------------------------------------------

/** "AKIA" — assembled from codepoints, never literal. */
const AKIA = cp(0x41, 0x4b, 0x49, 0x41);
/** "PRIVATE KEY" — assembled from codepoints, never literal. */
const PRIVATE_KEY_WORDS = cp(0x50, 0x52, 0x49, 0x56, 0x41, 0x54, 0x45) + " " + cp(0x4b, 0x45, 0x59);
/** "ghp_" — assembled from codepoints, never literal. */
const GHP = cp(0x67, 0x68, 0x70, 0x5f);

const PRIVATE_KEY_SECRET = "-----BEGIN RSA " + PRIVATE_KEY_WORDS + "-----";
const AWS_SECRET = AKIA + "ZQ0PLANTZQ4PLANT"; // prefix + 16 × [A-Z0-9]
const GITHUB_SECRET = GHP + "zqPLANTzqPLANTzqPLANTzqPLANTzqPLANT9"; // prefix + 36 chars
const BEARER_SECRET = cp(0x41) + "uthorization: " + cp(0x42) + "earer zqtokenPLANTzqtokenPLAN0"; // 24-char token
/** AKIA prefix followed by only 15 key chars — must NOT match (precision pin). */
const AWS_NEAR_MISS = AKIA + "ZQ0PLANTZQ4PLAN";

/**
 * The planned committed rows (SPEC §3.3's id<TAB>ERE format). Written into
 * a fixture only while the committed file is absent — see
 * `ensurePlannedPatterns`. Fragments that would themselves be secret-shaped
 * in source are assembled from the codepoint constants above.
 */
const PLANNED_PATTERNS: Array<[string, string]> = [
	["private-key", "-----BEGIN [A-Z ]*" + PRIVATE_KEY_WORDS + "-----"],
	["aws-access-key-id", "(A3T[A-Z0-9]|" + AKIA + "|ASIA)[A-Z0-9]{16}"],
	["github-token", "gh[pousr]_[A-Za-z0-9]{36,}"],
	["bearer-token", "[Aa]uthorization: *[Bb]earer +[A-Za-z0-9._~+/=-]{20,}"],
];

// Hostile path material (record-integrity arm): a filename carrying a raw
// single quote (the record's own path-field delimiter), a raw newline, and
// a raw ANSI escape, quote and controls from codepoints.
const HOSTILE_HEAD = "zqhostA";
const HOSTILE_TAIL = "zqhostB.txt";
const HOSTILE_NAME = HOSTILE_HEAD + cp(0x27) + cp(0x0a) + cp(0x1b) + "[31m" + HOSTILE_TAIL;

// High-byte path material (%XX-fidelity arm): U+00E9 lands on disk and in
// the index as the UTF-8 pair 0xC3 0xA9 — two bytes ≥ 0x80 for the
// sanitizer's byte loop, built from a codepoint per the header note.
const HIGH_BYTE_HEAD = "zqhi8a";
const HIGH_BYTE_NAME = HIGH_BYTE_HEAD + cp(0xe9) + "zqhi8b.txt";

// Binary staged input (unmeasurable-input arm): NUL bytes force git's
// numstat to the `-<TAB>-` no-line-counts outcome; the printable marker
// makes the content-absence assertion measurable.
const BINARY_MARKER = "zqbinPLANT";
const BINARY_CONTENT = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
	Buffer.from(BINARY_MARKER, "utf8"),
	Buffer.from([0x00, 0xff, 0xfe, 0x00]),
]);

// ---------------------------------------------------------------------------
// Substrate helpers.
// ---------------------------------------------------------------------------

/** Write a file into the fixture worktree and stage it (setup substrate). */
function stageFile(fixture: GithookFixture, name: string, content: string | Buffer): void {
	writeFileSync(join(fixture.root, name), content);
	fixtureGit(fixture, ["add", "--", name]);
}

/** The fixture's copy of the committed pattern-file path (read from the helper's own position, §3.3). */
function fixturePatternsPath(fixture: GithookFixture): string {
	return join(fixture.root, ".githooks", "helpers", "secret-patterns");
}

/**
 * Substrate choice (header note): while the committed pattern file is
 * absent, author the PLANNED rows into the fixture copy so a scan arm's red
 * is the scanner's absence, never a double absence; once Phase C commits
 * the file, the byte-verified fixture copy already carries it and this is a
 * no-op — the arms then measure the committed bytes, so a dropped committed
 * row reddens its refusal arm (§3.12's dropped-pattern mutant).
 */
function ensurePlannedPatterns(fixture: GithookFixture): void {
	const copied = fixturePatternsPath(fixture);
	if (existsSync(copied)) {
		return;
	}
	writeFileSync(copied, PLANNED_PATTERNS.map(([id, ere]) => `${id}\t${ere}`).join("\n") + "\n");
}

/** Build the standard scan fixture: bare remote (stage-1-derivable P) + feature branch. */
function buildScanFixture(): GithookFixture {
	const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
	fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);
	ensurePlannedPatterns(fixture);
	return fixture;
}

function notEnforcedLines(attempt: CommitAttempt): string[] {
	return attempt.auditDelta.split("\n").filter((line) => line.includes("not enforced"));
}

/**
 * Decimal-normalized cause shape: two causes that differ only in a measured
 * number (or a digit-differing filename — header note) are the SAME shape.
 */
function causeShape(cause: string): string {
	return cause.trim().replace(/\d+/g, "N");
}

/**
 * The §3.8 leak domain: a guarded value's bytes reach NONE of stderr,
 * stdout, or the audit delta — asserted at byte fidelity on all three.
 */
function assertBytesReachNoSurface(
	attempt: CommitAttempt,
	guarded: string | Buffer,
	what: string,
	arm: string,
): void {
	const bytes = typeof guarded === "string" ? Buffer.from(guarded, "utf8") : guarded;
	assert.equal(
		attempt.stderrBytes.includes(bytes),
		false,
		`${arm}: ${what} reached stderr — refusal surfaces never carry guarded content (§3.8)`,
	);
	assert.equal(
		attempt.stdoutBytes.includes(bytes),
		false,
		`${arm}: ${what} reached stdout — stdout is inside the leak-assertion domain (§3.8)`,
	);
	assert.equal(
		Buffer.from(attempt.auditDelta, "utf8").includes(bytes),
		false,
		`${arm}: ${what} reached the audit record — records never carry guarded content (§3.8)`,
	);
}

/**
 * The pattern-refusal observable (§3.3): a block record naming the secret
 * class, a non-zero commit, the adapter's live recovery line, the pattern
 * ID and offending path on BOTH refusal surfaces (issue #66 AC), and the
 * planted secret's bytes on NONE. While the helper is absent these arms
 * fail at the first assertion: the commit falls through fail-open and
 * appends no block record.
 */
function assertSecretRefused(
	attempt: CommitAttempt,
	patternId: string,
	stagedPath: string,
	secret: string,
	arm: string,
): void {
	assert.match(
		attempt.auditDelta,
		/\bblock\b.*\bsecret\b/,
		`${arm}: no block record naming the secret class was appended — the commit fell through the ` +
			`fail-open chain (red until .githooks/helpers/secret_scan.sh lands and scan_staged_secrets ` +
			`refuses this staged diff); delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.notEqual(attempt.status, 0, `${arm}: the guarded commit SUCCEEDED through the chain`);
	assert.match(
		attempt.stderr,
		/\[dev-shell\]/,
		`${arm}: the refusal reached the operator without the adapter's live recovery line (§3.11 arm-scoped remediation)`,
	);
	assert.equal(
		attempt.stderr.includes(patternId),
		true,
		`${arm}: the refusal's stderr does not name pattern '${patternId}' (§3.3 pattern-ID reporting)`,
	);
	assert.equal(
		attempt.auditDelta.includes(patternId),
		true,
		`${arm}: the audit record does not name pattern '${patternId}' (§3.3 pattern-ID reporting)`,
	);
	assert.equal(
		attempt.stderr.includes(stagedPath),
		true,
		`${arm}: the refusal's stderr does not name the offending path (issue #66 AC)`,
	);
	assert.equal(
		attempt.auditDelta.includes(stagedPath),
		true,
		`${arm}: the audit record does not name the offending path (issue #66 AC)`,
	);
	assertBytesReachNoSurface(attempt, secret, "the planted secret's bytes", arm);
}

/**
 * The ordinary-allow observable: commit succeeds, no block record, no
 * disarmed-gate ("not enforced") record. A `helper-missing` warn from
 * `safe_source`'s fail-open is OUT of scope here — it is the sourcing
 * tier's own degradation record, present exactly while the helper file is
 * absent, and pinning total silence would bind the pin to one tree state.
 */
function assertAllowedOrdinarily(attempt: CommitAttempt, arm: string): void {
	assert.equal(attempt.status, 0, `${arm}: ${attempt.stderr}`);
	assert.doesNotMatch(
		attempt.auditDelta,
		/\bblock\b/,
		`${arm}: an ordinary allow appended a block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.equal(
		notEnforcedLines(attempt).length,
		0,
		`${arm}: an ordinary allow carried the disarmed-gate signal — the two allows must stay separable (§3.9)`,
	);
}

/**
 * The machinery-degradation observable (§3.9): the commit is ALLOWED, no
 * block record, and exactly one warn record says the scan is not enforced.
 * The allow half holds in both tree states; the SIGNAL is red until the
 * helper lands and disarms with its warn (the branch-guard shape).
 */
function assertDisarmedOpen(attempt: CommitAttempt, arm: string): void {
	assert.equal(
		attempt.status,
		0,
		`${arm}: machinery degradation must fail open, never block (§3.9): ${attempt.stderr}`,
	);
	assert.doesNotMatch(
		attempt.auditDelta,
		/\bblock\b/,
		`${arm}: machinery degradation appended a block record — it is never the actor's refusal (§3.9); ` +
			`delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	const lines = notEnforcedLines(attempt);
	assert.equal(
		lines.length,
		1,
		`${arm}: expected exactly one audit record stating the scan is not enforced (§3.9's ` +
			`degradation-signal rule; red until scan_staged_secrets lands and disarms with its warn); ` +
			`delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.match(lines[0], /\bwarn\b/, `${arm}: the disarmed-gate record is a warn, never a block`);
}

// ---------------------------------------------------------------------------
// Pattern refusals — red-first, one arm per planned pattern ID so §3.12's
// dropped-pattern mutant dies for every committed row.
// ---------------------------------------------------------------------------

describe("staged-secret refusals, one arm per pattern (issue #66)", { skip: IS_WINDOWS }, () => {
	const cases: Array<[string, string, string]> = [
		["private-key", "zqleakpk.txt", PRIVATE_KEY_SECRET],
		["aws-access-key-id", "zqleakaws.txt", AWS_SECRET],
		["github-token", "zqleakgh.txt", GITHUB_SECRET],
		["bearer-token", "zqleakbr.txt", BEARER_SECRET],
	];
	for (const [patternId, stagedPath, secret] of cases) {
		it(`a staged ${patternId} match is refused, content-free`, () => {
			const fixture = buildScanFixture();
			try {
				stageFile(fixture, stagedPath, secret + "\n");
				const attempt = commitWithMessage(fixture, "chore: exercise the staged-secret arm\n");
				assertSecretRefused(attempt, patternId, stagedPath, secret, `staged ${patternId}`);
			} finally {
				removeGithookFixture(fixture);
			}
		});
	}

	it("a staged secret is refused under color.diff=always clone config (config-neutral measurement)", () => {
		// The measured object must not be rewritten by clone diff config
		// (§3.3's config-neutral domain rule): ANSI-colored diff output would
		// otherwise split the added-line match or smuggle escape bytes onto
		// the record surfaces.
		const fixture = buildScanFixture();
		try {
			fixtureGit(fixture, ["config", "color.diff", "always"]);
			stageFile(fixture, "zqleakcolor.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the colored-diff arm\n");
			assertSecretRefused(attempt, "aws-access-key-id", "zqleakcolor.txt", AWS_SECRET, "color.diff=always");
			assertBytesReachNoSurface(attempt, Buffer.from([0x1b]), "a raw ANSI escape byte", "color.diff=always");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a staged secret is refused with GIT_LITERAL_PATHSPECS=1 in the commit environment (env-neutral measurement)", () => {
		// The pathspec-magic env family must not rewrite the scan's path
		// addressing (§3.3's measurement-domain rule): with literal-pathspec
		// parsing forced by the inherited environment, an unneutralized
		// per-path read's `:(literal)` pathspec matches nothing and the scan
		// would vouch for a path it never measured. Ambient tooling sets this
		// variable, so the shape is reachable with no adversary.
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, "zqleakenv.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the ambient-env arm\n", {
				env: { GIT_LITERAL_PATHSPECS: "1" },
			});
			assertSecretRefused(attempt, "aws-access-key-id", "zqleakenv.txt", AWS_SECRET, "ambient pathspec env");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a CRLF-rendered pattern file still refuses (checkout-smudge cannot dud the pattern set)", () => {
		// core.autocrlf=true smudges the checked-out pattern file to CRLF
		// rows with no actor editing anything; each ERE then carries a
		// trailing CR that compiles cleanly yet can never match an
		// LF-terminated added line — an armed-looking scan that checks
		// nothing, with zero records. The parser strips the trailing CR, so
		// the smudged file scans exactly as the committed bytes.
		const fixture = buildScanFixture();
		try {
			writeFileSync(
				fixturePatternsPath(fixture),
				PLANNED_PATTERNS.map(([id, ere]) => `${id}\t${ere}`).join("\r\n") + "\r\n",
			);
			stageFile(fixture, "zqleakcrlf.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the CRLF-pattern-file arm\n");
			assertSecretRefused(attempt, "aws-access-key-id", "zqleakcrlf.txt", AWS_SECRET, "CRLF pattern file");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a worktree file named HEAD cannot disarm the scan (rev/path disambiguation)", () => {
		// Without an argv terminator after the diff base, a worktree file
		// named HEAD makes git refuse the rev/path ambiguity — and an
		// enumeration failure is the machinery arm, so the whole scan would
		// disarm OPEN on a file any actor can create with no flag and no
		// env. The enumeration's base must be terminated with `--`.
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, "HEAD", "ordinary text\n");
			stageFile(fixture, "zqleakhead.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the HEAD-file arm\n");
			assertSecretRefused(attempt, "aws-access-key-id", "zqleakhead.txt", AWS_SECRET, "HEAD-file path");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("an inherited unusable TMPDIR cannot disarm the scan (spool falls back to the git dir)", () => {
		// The enumeration spool must not turn the ambient temp dir into a
		// disarm lever: with TMPDIR pointing nowhere, the spool lands under
		// the repository's own git dir — writable at commit time — and the
		// staged secret is still refused.
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, "zqleaktmp.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the hostile-TMPDIR arm\n", {
				env: { TMPDIR: "/nonexistent-zqtmpdir" },
			});
			assertSecretRefused(attempt, "aws-access-key-id", "zqleaktmp.txt", AWS_SECRET, "hostile TMPDIR");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a refs/replace graft on HEAD cannot blind the staged diff (replace-neutral measurement)", () => {
		// A replace ref makes ordinary object reads resolve HEAD to a graft
		// of the actor's choosing: planting the secret's bytes in the graft
		// empties the staged diff against it — a command-invisible
		// repo-state bypass, unlike the tier's declared `--no-verify` door.
		// The scan's git children run with replace grafting disabled, so the
		// measured base is the real HEAD. The carrier commit below rides
		// `--no-verify` on purpose: it IS the declared door, used here only
		// to plant fixture state.
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, "zqreplace.txt", AWS_SECRET + "\n");
			fixtureGit(fixture, ["commit", "-q", "--no-verify", "-m", "carrier: fixture-local plant"]);
			fixtureGit(fixture, ["reset", "-q", "--hard", "HEAD~1"]);
			fixtureGit(fixture, ["replace", "HEAD", "ORIG_HEAD"]);
			stageFile(fixture, "zqreplace.txt", AWS_SECRET + "\n");
			stageFile(fixture, "zqbenign.txt", "ordinary text\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the replace-graft arm\n");
			assertSecretRefused(attempt, "aws-access-key-id", "zqreplace.txt", AWS_SECRET, "replace graft");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the FIRST commit of an unborn HEAD with a staged secret is refused (empty-tree diff boundary)", () => {
		// `git diff --cached` has no parent on an unborn HEAD; §3.3 keys this
		// by outcome — the scan diffs against the empty tree, never guesses.
		// No remote here on purpose: an unborn HEAD needs zero commits, so
		// the branch gate disarms (out of this arm's scope) and the scan must
		// still refuse. Substrate: planned rows authored while the committed
		// pattern file is absent (header note).
		const fixture = buildGithookFixture({});
		try {
			ensurePlannedPatterns(fixture);
			stageFile(fixture, "zqleakfirst.txt", GITHUB_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the unborn-HEAD arm\n");
			assertSecretRefused(attempt, "github-token", "zqleakfirst.txt", GITHUB_SECRET, "unborn HEAD");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Allow-list: domain exclusion, never approval (§3.3).
// ---------------------------------------------------------------------------

describe("the .shellsecretignore allow-list is domain exclusion (issue #66)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let allowedOnly: CommitAttempt;
	let alongside: CommitAttempt;

	before(() => {
		fixture = buildScanFixture();
		// Glob form on purpose — the contract admits literal or shell glob.
		writeFileSync(join(fixture.root, ".shellsecretignore"), "# fixture allow-list\nzqallow*.txt\n");
		stageFile(fixture, "zqallowed.txt", GITHUB_SECRET + "\n");
		allowedOnly = commitWithMessage(fixture, "chore: exercise the allow-listed path\n");
		// Second commit: the allow-listed path gains ANOTHER match while a
		// non-allow-listed path carries its own — exclusion must not become
		// approval of the neighbour.
		stageFile(fixture, "zqallowed.txt", GITHUB_SECRET + "\n" + AWS_SECRET + "\n");
		stageFile(fixture, "zqnotallowed.txt", GITHUB_SECRET + "\n");
		alongside = commitWithMessage(fixture, "chore: exercise the alongside path\n");
	});
	after(() => removeGithookFixture(fixture));

	it("a match only in an allow-listed path passes (boundary pin — green in both tree states)", () => {
		assertAllowedOrdinarily(allowedOnly, "allow-listed only");
	});

	it("a non-allow-listed match alongside an excluded one still refuses", () => {
		assertSecretRefused(alongside, "github-token", "zqnotallowed.txt", GITHUB_SECRET, "alongside");
		assertBytesReachNoSurface(alongside, AWS_SECRET, "the allow-listed path's secret bytes", "alongside");
	});
});

describe("an unreadable allow-list never widens the excused set (issue #66, SPEC §3.9)", { skip: IS_WINDOWS || IS_ROOT }, () => {
	it("present-but-unreadable .shellsecretignore: one degradation warn, and the scan refuses the listed path's secret", () => {
		// The excusing artifact's unreadability must not excuse (§3.3's
		// allow-list rule): the scan proceeds with NO exclusions and refuses
		// the secret sitting in the path the unreadable list names.
		const fixture = buildScanFixture();
		try {
			const ignorePath = join(fixture.root, ".shellsecretignore");
			writeFileSync(ignorePath, "zqallowed.txt\n");
			chmodSync(ignorePath, 0o000);
			stageFile(fixture, "zqallowed.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the unreadable allow-list arm\n");
			assertSecretRefused(attempt, "aws-access-key-id", "zqallowed.txt", AWS_SECRET, "unreadable allow-list");
			const warns = attempt.auditDelta.split("\n").filter((line) => /"action":"warn"/.test(line));
			assert.equal(
				warns.length,
				1,
				`unreadable allow-list: expected exactly one degradation warn record beside the refusal; ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Unmeasurable input refuses on its own cause (§3.9's measurement rule).
// ---------------------------------------------------------------------------

describe("an unmeasurable staged input refuses on its own cause (issue #66, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let patternRefusal: CommitAttempt;
	let binaryRefusal: CommitAttempt;

	before(() => {
		fixture = buildScanFixture();
		// Filenames differ only in a digit (header note): after decimal
		// normalization the two causes can differ only in their wording,
		// never in path spelling.
		stageFile(fixture, "zqmix2.txt", AWS_SECRET + "\n");
		patternRefusal = commitWithMessage(fixture, "chore: exercise the pattern-refusal reference\n");
		// A refused commit leaves its file staged; unstage it so the binary
		// attempt measures only its own input (a no-op while the chain is
		// fail-open and the first commit landed).
		fixtureGit(fixture, ["reset", "-q", "--", "zqmix2.txt"]);
		stageFile(fixture, "zqmix1.txt", BINARY_CONTENT);
		binaryRefusal = commitWithMessage(fixture, "chore: exercise the binary-input arm\n");
	});
	after(() => removeGithookFixture(fixture));

	it("a staged binary (numstat no-line-counts outcome) is refused with no pattern ID on the record", () => {
		assert.match(
			binaryRefusal.auditDelta,
			/\bblock\b.*\bsecret\b/,
			`binary input: no block record was appended — the commit fell through the fail-open chain ` +
				`(red until scan_staged_secrets lands and refuses what it cannot measure); ` +
				`delta: ${JSON.stringify(binaryRefusal.auditDelta)}`,
		);
		assert.notEqual(binaryRefusal.status, 0, "binary input: the guarded commit SUCCEEDED");
		for (const [patternId] of PLANNED_PATTERNS) {
			assert.equal(
				binaryRefusal.auditDelta.includes(patternId),
				false,
				`binary input: the record names pattern '${patternId}' — an unmeasurable-input refusal is ` +
					`not a pattern match (§3.9's split)`,
			);
		}
		assertBytesReachNoSurface(binaryRefusal, BINARY_MARKER, "the binary content's marker bytes", "binary input");
	});

	it("the unmeasurable-input cause is distinct at the observable from a pattern-match refusal", () => {
		// Both refusal preconditions repeat on purpose: while the chain is
		// fail-open, both causes are empty and a bare shape comparison would
		// green vacuously.
		assert.match(
			patternRefusal.auditDelta,
			/\bblock\b.*\bsecret\b/,
			`pattern reference: no block record (red until scan_staged_secrets lands); ` +
				`delta: ${JSON.stringify(patternRefusal.auditDelta)}`,
		);
		assert.match(
			binaryRefusal.auditDelta,
			/\bblock\b.*\bsecret\b/,
			`binary input: no block record (red until scan_staged_secrets lands); ` +
				`delta: ${JSON.stringify(binaryRefusal.auditDelta)}`,
		);
		assert.notEqual(binaryRefusal.cause, "", "an unmeasurable-input refusal owes its own cause line");
		assert.notEqual(
			causeShape(binaryRefusal.cause),
			causeShape(patternRefusal.cause),
			"the unmeasurable-input cause reuses the pattern-match shape — the two §3.3 refusal arms must " +
				"stay distinguishable at the observable",
		);
	});
});

// ---------------------------------------------------------------------------
// Machinery degradation fails open with exactly one warn (§3.9).
// ---------------------------------------------------------------------------

describe("scan machinery degradation disarms open with one warn (issue #66, SPEC §3.9, §3.10)", { skip: IS_WINDOWS }, () => {
	it("pattern file absent: the commit passes — staged secret included — with exactly one not-enforced warn", () => {
		// Substrate: the fixture copy of the pattern file is DELETED
		// post-build (a no-op while nothing ships) — the arm's contract is
		// the file's absence, so it never authors one.
		const fixture = buildScanFixture();
		try {
			rmSync(fixturePatternsPath(fixture), { force: true });
			stageFile(fixture, "zqleakopen.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the absent-pattern-file arm\n");
			assertDisarmedOpen(attempt, "pattern file absent");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("an up-front-invalid pattern line disarms the WHOLE run (valid rows beside it check nothing)", () => {
		// Substrate: a fixture-local authored file, unconditionally — the
		// arm's contract IS the degenerate file (an unbalanced group fails
		// ERE compile up front). A valid private-key row and a matching
		// staged secret sit beside it so a per-line-skip implementation
		// (refusing here) reddens: an up-front compile failure is machinery
		// for the RUN (§3.10's valid-AND-non-empty rule), never a partial scan.
		const fixture = buildScanFixture();
		try {
			writeFileSync(
				fixturePatternsPath(fixture),
				["zq-invalid\t(a|", PLANNED_PATTERNS[0].join("\t"), ""].join("\n"),
			);
			stageFile(fixture, "zqleakbadset.txt", PRIVATE_KEY_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the invalid-pattern-line arm\n");
			assertDisarmedOpen(attempt, "invalid pattern line");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a pattern set empty after stripping comments and blanks disarms open with the same warn", () => {
		// Substrate: fixture-local authored file of comments and blank lines
		// only — a scan that checks nothing is indistinguishable from
		// all-clear (§3.10), so it must say so rather than allow silently.
		const fixture = buildScanFixture();
		try {
			writeFileSync(fixturePatternsPath(fixture), "# no rows yet\n\n# still none\n");
			stageFile(fixture, "zqemptyset.txt", "ordinary text\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the empty-set arm\n");
			assertDisarmedOpen(attempt, "empty pattern set");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Hostile-path record integrity (§3.3 pattern-match outcome: sanitized path).
// ---------------------------------------------------------------------------

describe("a hostile-named path cannot split or forge a record (issue #66, SPEC §3.3, §3.8)", { skip: IS_WINDOWS }, () => {
	it("a secret in a newline/ANSI-named file lands exactly one unsplit record, raw path bytes nowhere", () => {
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, HOSTILE_NAME, AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the hostile-path arm\n");
			assert.match(
				attempt.auditDelta,
				/\bblock\b.*\bsecret\b/,
				`hostile path: no block record was appended — the commit fell through the fail-open chain ` +
					`(red until scan_staged_secrets lands); delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.notEqual(attempt.status, 0, "hostile path: the guarded commit SUCCEEDED");
			// Raw bytes reach no surface: the embedded newline (asserted as
			// the head marker + LF sequence — a sanitized rendering keeps the
			// marker but never a real LF after it) and the raw ESC byte.
			assertBytesReachNoSurface(attempt, HOSTILE_HEAD + cp(0x0a), "the raw newline path bytes", "hostile path");
			assertBytesReachNoSurface(attempt, Buffer.from([0x1b]), "the raw ESC byte", "hostile path");
			assertBytesReachNoSurface(attempt, AWS_SECRET, "the planted secret's bytes", "hostile path");
			// Every appended line is a well-formed record — a split record's
			// continuation line would start with path bytes, not a verb.
			const deltaLines = attempt.auditDelta.split("\n").filter((line) => line !== "");
			for (const line of deltaLines) {
				assert.match(
					line,
					/^\{"timestamp":"[^"]*","category":"[^"]*","action":"(block|warn)","text":"/,
					`hostile path: a record line does not open a well-formed record — a path byte split or forged ` +
						`a record: ${JSON.stringify(line)}`,
				);
			}
			// Exactly ONE record names the (sanitized) path, and it holds
			// both halves on one line.
			const naming = deltaLines.filter((line) => line.includes(HOSTILE_HEAD));
			assert.equal(
				naming.length,
				1,
				`hostile path: expected exactly one record naming the sanitized path; ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.equal(
				naming[0].includes(HOSTILE_TAIL),
				true,
				"hostile path: the record splits the path — its head and tail must sit on ONE record line",
			);
			assert.match(naming[0], /\bblock\b/, "hostile path: the path-naming record is the refusal's block record");
			// The path's own quote renders as %27: a raw quote inside the
			// quoted path field would terminate it early and forge the field
			// for any quote-delimited reader.
			assert.equal(
				naming[0].includes(HOSTILE_HEAD + "%27"),
				true,
				`hostile path: the path's single quote is not percent-encoded on the record — a raw quote ` +
					`forges the path field's boundary: ${JSON.stringify(naming[0])}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a path byte ≥ 0x80 renders as its own uppercase two-hex-digit escape on the record (%XX fidelity)", () => {
		// The sanitizer's stated rendering is one uppercase %XX per byte; a
		// sign-extending renderer keeps the encoding injective but falsifies
		// that contract for every non-ASCII path, so the pin is the positive
		// rendering: the U+00E9 byte pair as exactly `%C3%A9` on both refusal
		// surfaces, with the raw pair on neither.
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, HIGH_BYTE_NAME, AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the high-byte-path arm\n");
			assert.match(
				attempt.auditDelta,
				/\bblock\b.*\bsecret\b/,
				`high-byte path: no block record was appended — the commit fell through the chain; ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.notEqual(attempt.status, 0, "high-byte path: the guarded commit SUCCEEDED");
			assertBytesReachNoSurface(
				attempt,
				Buffer.from([0xc3, 0xa9]),
				"the raw ≥0x80 path byte pair",
				"high-byte path",
			);
			assertBytesReachNoSurface(attempt, AWS_SECRET, "the planted secret's bytes", "high-byte path");
			const naming = attempt.auditDelta.split("\n").filter((line) => line.includes(HIGH_BYTE_HEAD));
			assert.equal(
				naming.length,
				1,
				`high-byte path: expected exactly one record naming the sanitized path; ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.equal(
				naming[0].includes("%C3%A9"),
				true,
				`high-byte path: the record's sanitized path does not render the ≥0x80 byte pair as %C3%A9 ` +
					`(one uppercase %XX per byte — the stated §3.3 rendering): ${JSON.stringify(naming[0])}`,
			);
			assert.equal(
				attempt.stderr.includes("%C3%A9"),
				true,
				"high-byte path: the refusal's stderr does not carry the %C3%A9 rendering of the offending path",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The protected-branch commit arm (armed by the same landing).
// ---------------------------------------------------------------------------

describe("the protected-branch commit arm (issue #66, SPEC §3.3 ref-identity semantics)", { skip: IS_WINDOWS }, () => {
	it("a commit with HEAD on the derived identity is refused with a content-free constant + recovery", () => {
		// HEAD stays on the fixture default = P; stage 1 derives P from the
		// local remote pointer. Content-free is the arm's second half: the
		// adapter's current block message interpolates the branch name, and
		// the arming commit owes its content-free rewrite keeping the
		// recovery half.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = commitWithMessage(fixture, "chore: exercise the commit-on-P arm\n");
			assert.match(
				attempt.auditDelta,
				/\bblock\b.*\bbranch\b/,
				`commit on P: no block record naming the branch class — the commit fell through the ` +
					`fail-open chain (red until secret_scan.sh completes pre-commit's require chain); ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.notEqual(attempt.status, 0, "commit on P: the guarded commit SUCCEEDED through the chain");
			assert.match(
				attempt.stderr,
				/\[dev-shell\]/,
				"commit on P: the refusal reached the operator without the adapter's live recovery line (§3.11)",
			);
			assertBytesReachNoSurface(attempt, PROTECTED, "the protected refname's bytes", "commit on P");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("network-guard negative: with stage 1 underivable, the commit surface disarms instead of dialing out", () => {
		// Outcome proxy (deterministic): the local pointer is absent
		// (omitHeadPointer) while the bare remote's advertised default IS
		// derivable — if the commit surface ever ran stage 2, `ls-remote`
		// against the fixture-local remote would derive P and REFUSE this
		// commit. The commit-surface contract is the opposite observable:
		// allow, plus exactly one not-enforced warn (the disarmed gate says
		// so plainly), which separates "stage 2 never ran" from "stage 2
		// ran" without instrumenting the network.
		const fixture = buildGithookFixture({
			remote: { defaultBranch: PROTECTED, omitHeadPointer: true },
		});
		try {
			const attempt = commitWithMessage(fixture, "chore: exercise the network-guard negative arm\n");
			assert.equal(
				attempt.status,
				0,
				`network negative: the commit surface refused — it reached stage 2's remote read, which ` +
					`pre-commit must never do: ${attempt.stderr}`,
			);
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`network negative: a block record on the disarmed surface; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			const lines = notEnforcedLines(attempt);
			assert.equal(
				lines.length,
				1,
				`network negative: expected exactly one not-enforced warn (red today — the inert chain ` +
					`exits before the branch predicate runs and emits no branch record); ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.match(lines[0], /\bwarn\b/, "network negative: the disarmed-gate record is a warn");
			assertBytesReachNoSurface(attempt, PROTECTED, "the protected refname's bytes", "network negative");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a feature-branch commit passes ordinarily (boundary pin — green in both tree states)", () => {
		const fixture = buildScanFixture();
		try {
			const attempt = commitWithMessage(fixture, "chore: exercise the feature-branch allow\n");
			assertAllowedOrdinarily(attempt, "feature-branch commit");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// Boundary pins — green in both tree states, declared as pins.
// ---------------------------------------------------------------------------

describe("boundary pins — green in both tree states (issue #66)", { skip: IS_WINDOWS }, () => {
	// Every arm here pins the floor the armed helper must not break: they
	// hold while `.githooks/helpers/secret_scan.sh` is absent (fail-open
	// chain) AND after it lands. None of them is a red-first claim.

	it("a clean commit with near-miss content passes ordinarily (pattern precision pin)", () => {
		// The near-miss (AKIA prefix + only 15 key characters) must not
		// match: an over-widened pattern is a false block on ordinary text.
		const fixture = buildScanFixture();
		try {
			stageFile(fixture, "zqnearmiss.txt", "prefix-shaped but short: " + AWS_NEAR_MISS + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the near-miss pin\n");
			assertAllowedOrdinarily(attempt, "near-miss commit");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper file absent: the commit no-ops open, staged secret and protected HEAD included", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		removeDelegatedHelpers(fixture);
		try {
			stageFile(fixture, "zqnoop1.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the absent-helper no-op\n");
			assert.equal(
				attempt.status,
				0,
				`an absent helper must degrade to allow, never to a false block (githook_source fail-open): ${attempt.stderr}`,
			);
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`absent helper: a no-op appended a block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper present without scan_staged_secrets: the branch arm still decides — only the secret arm degrades", () => {
		// Per-arm degradation: the custom helper dir carries the REAL
		// branch_guard.sh plus a stub secret_scan.sh that defines everything
		// except the delegated function. HEAD sits on the derived protected
		// identity, so the branch arm — whose helper is complete — must
		// refuse this commit; a stale secret helper never folds the
		// neighbour that already has everything it needs.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		removeDelegatedHelpers(fixture);
		try {
			cpSync(
				join(repoRoot(), ".githooks", "helpers", "branch_guard.sh"),
				join(fixture.helpersDir, "branch_guard.sh"),
			);
			writeFileSync(
				join(fixture.helpersDir, "secret_scan.sh"),
				"# stub helper: sources cleanly, defines everything except the delegated function\nunrelated_scan_function() { :; }\n",
			);
			stageFile(fixture, "zqnoop2.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the per-arm degradation pin\n");
			assert.match(
				attempt.auditDelta,
				/\bblock\b.*\bbranch\b/,
				`stub secret helper: the branch arm did not refuse a commit on P — an incomplete secret helper ` +
					`folded the armed neighbour (per-arm degradation, §3.9); delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.notEqual(attempt.status, 0, "stub secret helper: the commit on P SUCCEEDED");
			assert.match(
				attempt.stderr,
				/\[dev-shell\]/,
				"stub secret helper: the branch refusal reached the operator without the adapter's recovery line",
			);
			assertBytesReachNoSurface(attempt, AWS_SECRET, "the staged secret's bytes", "stub secret helper");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a branch helper that sources cleanly but defines nothing degrades loudly, never silently", () => {
		// The stub shape satisfies safe_source, so the only possible signal
		// is the require guard's own record: folding open from this arm on
		// is the tier's contract, but a fold with ZERO records is not —
		// §3.9's degradation-signal rule binds the require miss too.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		removeDelegatedHelpers(fixture);
		try {
			fixtureGit(fixture, ["checkout", "-q", "-b", FEATURE]);
			writeFileSync(
				join(fixture.helpersDir, "branch_guard.sh"),
				"# stub helper: sources cleanly, defines none of the delegated functions\n",
			);
			// Every OTHER helper is the real one: the binding is complete but
			// for the stubbed branch guard, so the one warn below is the
			// require guard's own record, not a neighbouring hook's noise.
			cpSync(
				join(repoRoot(), ".githooks", "helpers", "secret_scan.sh"),
				join(fixture.helpersDir, "secret_scan.sh"),
			);
			cpSync(
				join(repoRoot(), ".githooks", "helpers", "conventional_commit.sh"),
				join(fixture.helpersDir, "conventional_commit.sh"),
			);
			stageFile(fixture, "zqleakbstub.txt", AWS_SECRET + "\n");
			const attempt = commitWithMessage(fixture, "chore: exercise the silent-stub arm\n");
			assert.equal(attempt.status, 0, `stub branch helper: the fold-open contract broke: ${attempt.stderr}`);
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`stub branch helper: a degraded arm appended a block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			const warns = attempt.auditDelta.split("\n").filter((line) => /"action":"warn"/.test(line));
			assert.equal(
				warns.length,
				1,
				`stub branch helper: expected exactly one warn record for the silent fold (§3.9's ` +
					`degradation-signal rule); delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.match(
				warns[0],
				/\brequire-missing\b/,
				"stub branch helper: the degradation record does not name the require miss",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the secret arm's block message is a non-interpolating constant (re-pin, structural)", () => {
		// The adapter's secret-arm message is already a constant and the
		// arming commit re-pins rather than rewrites it; `githook_block`
		// interpolates its argument raw, so a `$` on that line would put
		// live bytes on the record surfaces.
		const source = readFileSync(join(repoRoot(), ".githooks", "pre-commit"), "utf8");
		const line = source.split("\n").find((candidate) => candidate.includes("githook_block secret"));
		assert.notEqual(line, undefined, "pre-commit no longer carries the secret arm's block call");
		assert.equal(
			(line as string).includes("$"),
			false,
			`the secret arm's block message interpolates — it must stay a content-free constant (§3.9): ${line}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Committed pattern-file pins — red until Phase C lands the file, asserted
// against the REPOSITORY path (never a fixture substitute): the object under
// pin is the committed bytes both readers resolve.
// ---------------------------------------------------------------------------

describe("the committed pattern file compiles for both readers (issue #66, SPEC §3.3)", { skip: IS_WINDOWS }, () => {
	const patternsPath = join(repoRoot(), ".githooks", "helpers", "secret-patterns");
	const missingMsg =
		"red until the Code phase lands .githooks/helpers/secret-patterns (§6.1: the pattern file ships with its scanner)";

	function committedRows(): Array<{ n: number; id: string; ere: string; line: string }> {
		const rows: Array<{ n: number; id: string; ere: string; line: string }> = [];
		readFileSync(patternsPath, "utf8")
			.split("\n")
			.forEach((line, index) => {
				if (/^[ \t]*$/.test(line) || line.startsWith("#")) {
					return;
				}
				const tab = line.indexOf("\t");
				rows.push({
					n: index + 1,
					id: tab === -1 ? line : line.slice(0, tab),
					ere: tab === -1 ? "" : line.slice(tab + 1),
					line,
				});
			});
		return rows;
	}

	it("every line is id<TAB>ERE inside the declared common subset (syntactic lint)", () => {
		// The lint carries what a bare RegExp compile cannot (see the next
		// arm's note): the format's forbidden constructs — POSIX bracket
		// classes and backslash-letter classes — are exactly the ones JS
		// accepts silently under a reinterpreted meaning.
		assert.equal(existsSync(patternsPath), true, missingMsg);
		const rows = committedRows();
		assert.equal(
			rows.length > 0,
			true,
			"the committed set must be non-empty after stripping comments and blanks (§3.10 valid-AND-non-empty)",
		);
		for (const row of rows) {
			assert.equal(row.line.includes("\t"), true, `line ${row.n}: no tab delimiter (id<TAB>ERE)`);
			assert.match(
				row.id,
				/^[a-z][a-z0-9-]*$/,
				`line ${row.n}: id ${JSON.stringify(row.id)} is not a lowercase-hyphen token`,
			);
			assert.equal(row.ere.length > 0, true, `line ${row.n}: empty regex`);
			assert.equal(
				row.ere.includes("[[:"),
				false,
				`line ${row.n}: POSIX bracket class — outside the committed common subset (§3.3)`,
			);
			assert.doesNotMatch(
				row.ere,
				/\\[A-Za-z]/,
				`line ${row.n}: backslash-letter escape — outside the committed common subset (§3.3)`,
			);
		}
	});

	it("every committed regex compiles as a JS RegExp (the second reader's throw check only)", () => {
		// Ground stated in place: a bare RegExp compile alone pins almost
		// nothing — JS silently ACCEPTS the constructs the format forbids
		// (a POSIX class parses as an ordinary character class), so this arm
		// was measured vacuous as the sole compat pin. It keeps only what it
		// can pin — no committed line may throw at the second reader — while
		// the lint above and the ERE probe below carry the subset.
		assert.equal(existsSync(patternsPath), true, missingMsg);
		for (const row of committedRows()) {
			assert.doesNotThrow(
				() => new RegExp(row.ere),
				`line ${row.n}: the regex does not compile as a JS RegExp (§3.3 both-reader resolvability)`,
			);
		}
	});

	it("every committed regex compiles on the ERE side, keyed by outcome (bash [[ =~ ]] probe)", () => {
		// One child bash per line, LC_ALL=C — the hook interpreter's own ERE
		// engine (§3.3's pinned matcher). Keyed by outcome, not message
		// (§3.10): [[ =~ ]] answers 0 (match) or 1 (no match) for a compiled
		// regex and 2 for a regcomp failure.
		assert.equal(existsSync(patternsPath), true, missingMsg);
		for (const row of committedRows()) {
			const probe = spawnSync("bash", ["-c", '[[ "zq-ere-probe" =~ $1 ]]; exit "$?"', "bash", row.ere], {
				env: { PATH: process.env.PATH ?? "", LC_ALL: "C" },
			});
			assert.notEqual(probe.status, null, `line ${row.n}: the ERE probe did not run`);
			assert.notEqual(
				probe.status,
				2,
				`line ${row.n}: the platform's regcomp rejects this regex (§3.3 both-reader resolvability): ` +
					`${(probe.stderr ?? Buffer.alloc(0)).toString("utf8")}`,
			);
			assert.equal(
				probe.status === 0 || probe.status === 1,
				true,
				`line ${row.n}: unexpected probe outcome ${probe.status}`,
			);
		}
	});
});
