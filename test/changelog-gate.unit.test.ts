/**
 * Unit suite for the changelog fragment-gate predicate (issue #43).
 *
 * Subject under test: `.github/workflows/check-changelog.sh`, the gate body
 * the `fragment-gate` job calls. It is driven here entirely through its two
 * seams — the PR file listing on stdin and the fragment tree at `--root` —
 * so the suite needs no network, no `gh`, and no `pi`.
 *
 * Invocation contract:
 *
 *   printf '%s' "$FILES_JSON" | bash check-changelog.sh \
 *     --pr <n> --expected-count <n> --allowed "<stems>" --root <dir>
 *
 * stdin is the shape `gh api --paginate --slurp .../pulls/N/files` produces:
 * an array of pages, each page an array of file objects (flatten `.[][]`).
 * Exit 0 = pass, exit 1 = block; no third code is in the contract.
 *
 * The predicate under test is SPEC §1.3's one sentence — "CI enforces the
 * floor — at least one valid in-allow-set fragment or the skip label, with
 * every added fragment valid" — where `added` qualifies only the second
 * clause. It therefore has two independent clauses over the NET file listing:
 *
 *   Clause 1 (existential floor, permissive). At least one entry whose
 *     status is not `removed`, whose path matches the fragment shape, whose
 *     stem is in the allow-set, and whose content is valid. A fragment that
 *     fails clause 1 is merely not a witness — failing it is never itself a
 *     reason to block.
 *   Clause 2 (universal, no-junk). Every `added`/`renamed`/`copied` entry
 *     matching the fragment shape is valid. One valid fragment never excuses
 *     a malformed sibling. Exempt: a re-categorising move — an `added` stem
 *     that also appears among the listing's `removed` stems, or a `renamed`
 *     entry whose stem is unchanged — which was validated when it was first
 *     added.
 *
 * Two fail-closed arms run before either clause and must stay distinguishable
 * from clause 1, so a transport-shaped failure is never reported as "the
 * author forgot a fragment": a flattened length that disagrees with
 * `--expected-count` (truncation), and a `status` outside the known set.
 *
 * Fragment validity is the pre-existing contract of
 * `changelog_unreleased/TEMPLATE.md`: positive-integer stem with no leading
 * zero, a line matching `^- `, that same line carrying `(#<stem>)`, and the
 * stem in the allow-set.
 *
 * Every fixture lives under `tmpdir()`. The harness asserts `git status
 * --porcelain` is byte-identical across the suite (`harness/run-pi.ts`), so a
 * fixture written into the repository tree would red an unrelated suite.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const SCRIPT = join(repoRoot(), ".github", "workflows", "check-changelog.sh");

/** The pass-path marker the gate prints on stdout, with its counts. */
const MARKER = "check-changelog: net PR file listing";

/**
 * The fragment path shape, restated here from `changelog_unreleased/TEMPLATE.md`
 * so a fixture can be checked against it. T7 uses it to prove its own
 * non-fragment entry really is one.
 */
const FRAGMENT_PATH = /^changelog_unreleased\/(added|changed|deprecated|removed|fixed|security)\/[0-9]+\.md$/;

/**
 * T7's non-fragment entry. Named, because T7's discriminating power depends on
 * this path lying outside `FRAGMENT_PATH`: an implementation that classifies
 * status by substring would read "add" as "added" and then find nothing of
 * fragment shape to validate, so the run would pass instead of blocking. T7
 * asserts the property rather than assuming it.
 */
const T7_NON_FRAGMENT = "README.md";

/**
 * Clause-1's distinguishing token, matched case-insensitively: the contract
 * fixes the words, not the sentence-initial capital. Case-insensitivity also
 * makes every "and NOT clause 1" assertion strictly stronger.
 */
const NO_FRAGMENT = /no fragment/i;
/** Clause-1's live remediation: the label that legitimately bypasses the floor. */
const SKIP_LABEL = /skip-changelog/;

/**
 * Every exit-1 arm names a live positive remediation. This is the union of
 * the per-arm remediations; T10 holds every blocking fixture to it.
 */
const REMEDIATION = /skip-changelog|re-run|Rename the file|Closes|TEMPLATE\.md/;

interface FileEntry {
	filename: string;
	status: string;
	previous_filename?: string;
}

interface CaseSpec {
	id: string;
	/** The invariant this fixture pins, in the present tense. */
	summary: string;
	/** Fragment tree written under the case root, keyed by repo-relative path. */
	files: Record<string, string>;
	/** stdin payload: an array of pages, each page an array of file objects. */
	pages: FileEntry[][];
	expectedCount: number;
	/** Whitespace-separated allow-set in one argument: PR number ∪ closing issues. */
	allowed: string;
	pr: number;
	/** Exit 1 expected — the set T10 sweeps. */
	expectBlock: boolean;
	/**
	 * Reuse another case's root and files. Two payload shapes over one
	 * identical tree make their outputs directly comparable.
	 */
	shareRootWith?: string;
}

interface GateResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** A fragment body that satisfies the TEMPLATE.md bullet contract for `stem`. */
function validBullet(stem: number): string {
	return `- A user-observable change worth one line. (#${stem})\n`;
}

const CASES: CaseSpec[] = [
	{
		id: "T1",
		summary: "one added valid in-allow-set fragment satisfies the floor",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "added" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
	{
		id: "T2",
		summary: "a modified out-of-allow-set fragment rides alongside a valid added one",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/added/17.md": validBullet(17),
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: "changelog_unreleased/added/17.md", status: "modified" },
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
	{
		id: "T4",
		summary: "an added fragment whose stem is outside the allow-set violates clause 2",
		files: { "changelog_unreleased/fixed/99.md": validBullet(99) },
		pages: [[{ filename: "changelog_unreleased/fixed/99.md", status: "added" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T5",
		summary: "a valid added fragment does not excuse a malformed added sibling",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			// In the allow-set, so the sole defect is the bullet form.
			"changelog_unreleased/fixed/44.md": "Not a bullet at all (#44)\n",
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: "changelog_unreleased/fixed/44.md", status: "added" },
			],
		],
		expectedCount: 2,
		allowed: "43 44",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T6",
		summary: "a listing shorter than --expected-count is refused as truncated, not as missing",
		// Clause 1 would be satisfied by this tree; only truncation blocks.
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "added" }]],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T7",
		// "add" is a substring of "added": an implementation that classifies by
		// substring rather than by equality would accept it silently.
		summary: "an unknown file status is refused as unrecognized, not as missing",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: T7_NON_FRAGMENT, status: "add" },
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T8",
		// The path is deliberately absent from the fixture tree: at PR HEAD a
		// removed file is not on disk, and the gate must not try to read it.
		summary: "a removed fragment is no witness and the refusal says so in clause-1 terms",
		files: {},
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "removed" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T9",
		// previous_filename carries stem 12; the new stem 77 differs, so this is
		// a stem change rather than an exempt re-categorising move.
		summary: "a rename cannot smuggle an out-of-allow-set stem past clause 2",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/fixed/77.md": validBullet(77),
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{
					filename: "changelog_unreleased/fixed/77.md",
					status: "renamed",
					previous_filename: "changelog_unreleased/fixed/12.md",
				},
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T11",
		summary: "a two-page payload reads identically to the equivalent single-page one",
		files: {},
		shareRootWith: "T2",
		pages: [
			[{ filename: "changelog_unreleased/fixed/43.md", status: "added" }],
			[{ filename: "changelog_unreleased/added/17.md", status: "modified" }],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
	{
		id: "T12",
		summary: "a modified in-allow-set fragment satisfies the floor on its own",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "modified" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
	// T13 and T15 are a pair, and are a pair for one reason. A re-categorising
	// move can reach the file listing in either of two shapes — an `added`
	// entry whose stem also appears among the listing's `removed` entries, or a
	// single `renamed` entry whose stem is unchanged — and this repository
	// holds no rename precedent that settles which shape the platform reports
	// (`git log --all --diff-filter=R --name-status` is empty; the `renamed`
	// entry count over the merged PRs' file listings is zero). The exemption is
	// therefore pinned on both paths, neither standing in for the other: a
	// clause left without an executable form is stranded, and the stranded half
	// is as likely to be the one production takes as the pinned half.
	{
		id: "T13",
		// Stem 32 is NOT in the allow-set: without the move exemption clause 2
		// blocks this re-categorisation of an already-merged fragment.
		summary: "a re-categorising move of an already-merged fragment is exempt from clause 2",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/fixed/32.md": validBullet(32),
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: "changelog_unreleased/fixed/32.md", status: "added" },
				{ filename: "changelog_unreleased/added/32.md", status: "removed" },
			],
		],
		expectedCount: 3,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
	{
		id: "T14",
		// Clause 2 is vacuous here — nothing is added — so only clause 1 speaks.
		summary: "a modified out-of-allow-set fragment alone leaves the floor unmet",
		files: { "changelog_unreleased/added/17.md": validBullet(17) },
		pages: [[{ filename: "changelog_unreleased/added/17.md", status: "modified" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T15",
		// The other half of the pair described above T13. Stem 28 is unchanged
		// across the rename (`added/28.md` → `fixed/28.md`) and is NOT in the
		// allow-set, so without the move exemption clause 2 blocks it; the 43
		// fragment is the separate in-allow-set witness that keeps clause 1 out
		// of the question.
		summary: "a rename that leaves the stem unchanged is exempt from clause 2",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/fixed/28.md": validBullet(28),
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{
					filename: "changelog_unreleased/fixed/28.md",
					status: "renamed",
					previous_filename: "changelog_unreleased/added/28.md",
				},
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
];

const roots = new Map<string, string>();
const results = new Map<string, GateResult>();

function buildRoot(spec: CaseSpec): string {
	if (spec.shareRootWith !== undefined) {
		const shared = roots.get(spec.shareRootWith);
		assert.ok(shared, `${spec.id} shares the root of ${spec.shareRootWith}, which must be built first`);
		return shared;
	}
	const root = mkdtempSync(join(tmpdir(), `ghjig-changelog-${spec.id}-`));
	for (const [relPath, content] of Object.entries(spec.files)) {
		const target = join(root, relPath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}

function runGate(spec: CaseSpec, root: string): GateResult {
	const args = [
		SCRIPT,
		"--pr",
		String(spec.pr),
		"--expected-count",
		String(spec.expectedCount),
		"--allowed",
		spec.allowed,
		"--root",
		root,
	];
	const options = { input: JSON.stringify(spec.pages), encoding: "utf8" as const };
	try {
		const stdout = execFileSync("bash", args, options);
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number | null; stdout?: string; stderr?: string };
		return {
			// A signal death or a spawn failure carries no numeric status; -1
			// keeps it distinguishable from both contract exit codes rather than
			// being folded into "blocked".
			status: typeof failure.status === "number" ? failure.status : -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}

/** The result for `id`, which the module-level `before` has already produced. */
function resultOf(id: string): GateResult {
	const result = results.get(id);
	assert.ok(result, `no recorded gate result for ${id}`);
	return result;
}

/** The single stdout line carrying the pass marker; absence is itself a failure. */
function markerLine(result: GateResult): string {
	const line = result.stdout.split("\n").find((candidate) => candidate.includes(MARKER));
	assert.ok(line !== undefined, `expected a stdout line containing "${MARKER}"`);
	return line;
}

before(() => {
	for (const spec of CASES) {
		const root = buildRoot(spec);
		roots.set(spec.id, root);
		results.set(spec.id, runGate(spec, root));
	}
});

after(() => {
	for (const root of new Set(roots.values())) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("T1 — one added valid in-allow-set fragment (clause 1 satisfied)", () => {
	it("passes", () => {
		assert.equal(resultOf("T1").status, 0);
	});

	it("reports the net listing on stdout", () => {
		assert.ok(markerLine(resultOf("T1")).length > 0);
	});
});

describe("T2 — a modified out-of-allow-set fragment beside a valid added one (issue #43)", () => {
	it("passes: a correction to an already-merged fragment is not junk", () => {
		assert.equal(resultOf("T2").status, 0);
	});
});

describe("T4 — an added fragment whose stem is outside the allow-set (clause 2)", () => {
	it("blocks", () => {
		assert.equal(resultOf("T4").status, 1);
	});

	it("names the offending stem on stderr", () => {
		assert.match(resultOf("T4").stderr, /99/);
	});

	it("names a live remediation for the stem mismatch", () => {
		assert.match(resultOf("T4").stderr, /Rename the file|Closes/);
	});
});

describe("T5 — a malformed added sibling beside a valid added fragment (clause 2)", () => {
	it("blocks: one valid fragment does not excuse a malformed sibling", () => {
		assert.equal(resultOf("T5").status, 1);
	});

	it("names the offending stem on stderr", () => {
		assert.match(resultOf("T5").stderr, /44/);
	});
});

describe("T6 — the flattened listing disagrees with --expected-count (truncation)", () => {
	it("blocks", () => {
		assert.equal(resultOf("T6").status, 1);
	});

	it("reports the listing as incomplete", () => {
		assert.match(resultOf("T6").stderr, /incomplete/i);
	});

	it("names re-running as the remediation", () => {
		assert.match(resultOf("T6").stderr, /re-run/i);
	});

	it("is distinguishable from the clause-1 refusal", () => {
		assert.doesNotMatch(resultOf("T6").stderr, NO_FRAGMENT);
	});
});

describe("T7 — a file status outside the known set", () => {
	it("carries a non-fragment entry: the case measures status classification, not path shape", () => {
		assert.doesNotMatch(T7_NON_FRAGMENT, FRAGMENT_PATH);
	});

	it("blocks", () => {
		assert.equal(resultOf("T7").status, 1);
	});

	it("reports the status as unrecognized", () => {
		assert.match(resultOf("T7").stderr, /Unrecognized file status/);
	});

	it("names re-running as the remediation", () => {
		assert.match(resultOf("T7").stderr, /re-run/i);
	});

	it("is distinguishable from the clause-1 refusal", () => {
		assert.doesNotMatch(resultOf("T7").stderr, NO_FRAGMENT);
	});
});

describe("T8 — a removed fragment is the only fragment-path entry", () => {
	it("blocks", () => {
		assert.equal(resultOf("T8").status, 1);
	});

	it("refuses in clause-1 terms", () => {
		assert.match(resultOf("T8").stderr, NO_FRAGMENT);
	});

	it("offers the skip label as the live remediation", () => {
		assert.match(resultOf("T8").stderr, SKIP_LABEL);
	});

	it("does not blame a missing file: the gate states the reason it actually refused", () => {
		assert.doesNotMatch(resultOf("T8").stderr, /No such file/i);
	});
});

describe("T9 — a rename to an out-of-allow-set stem beside a valid added fragment (clause 2)", () => {
	it("blocks", () => {
		assert.equal(resultOf("T9").status, 1);
	});

	it("names the renamed-to stem on stderr", () => {
		assert.match(resultOf("T9").stderr, /77/);
	});
});

describe("T10 — every blocking arm names a live positive remediation", () => {
	// Table-driven over the case registry, so an arm added later is swept
	// without being enrolled by hand.
	for (const spec of CASES.filter((candidate) => candidate.expectBlock)) {
		it(`${spec.id} points at an act the author can perform`, () => {
			assert.match(resultOf(spec.id).stderr, REMEDIATION);
		});
	}
});

describe("T11 — a two-page payload flattens to the same listing as one page", () => {
	it("passes", () => {
		assert.equal(resultOf("T11").status, 0);
	});

	it("reports the same counts as the equivalent single-page payload", () => {
		assert.equal(markerLine(resultOf("T11")), markerLine(resultOf("T2")));
	});
});

describe("T12 — a modified in-allow-set fragment and nothing added (clause 1)", () => {
	it("passes: the floor is satisfied by a modified fragment", () => {
		assert.equal(resultOf("T12").status, 0);
	});
});

describe("T13 — a re-categorising move of an already-merged fragment (clause 2 exemption)", () => {
	it("passes: an added stem whose removal is in the same listing was validated when first added", () => {
		assert.equal(resultOf("T13").status, 0);
	});
});

describe("T14 — a modified out-of-allow-set fragment and nothing else (clause 1)", () => {
	it("blocks: the permissive clause does not pass an empty floor", () => {
		assert.equal(resultOf("T14").status, 1);
	});

	it("refuses in clause-1 terms", () => {
		assert.match(resultOf("T14").stderr, NO_FRAGMENT);
	});

	it("offers the skip label as the live remediation", () => {
		assert.match(resultOf("T14").stderr, SKIP_LABEL);
	});
});

describe("T15 — a rename that leaves the stem unchanged (clause 2 exemption)", () => {
	it("passes: a renamed fragment whose stem is unchanged was validated when first added", () => {
		assert.equal(resultOf("T15").status, 0);
	});
});
