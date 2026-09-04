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
 *     a malformed sibling. A re-categorising move — an `added` stem that also
 *     appears among the listing's `removed` fragment stems, or a `renamed`
 *     entry from one fragment path to another leaving the stem unchanged — is
 *     exempt from the allow-set rule ALONE, because that stem was in the
 *     allow-set of the PR that first added the fragment. Every other rule
 *     keeps running on it.
 *
 * Three fail-closed arms run before either clause and must stay
 * distinguishable from clause 1, so a transport-shaped failure is never
 * reported as "the author forgot a fragment": a payload the gate read no
 * entries from at all, a flattened length that disagrees with
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
 *
 * Issue #49 names five single-edit weakenings of the script; this file
 * carries exactly five killers, one per weakening, each marked at its site
 * with the weakening number it kills: 1 → T27, 2 → S1, 3 → T28, 4 → T7's
 * enum-extension assertion, 5 → T9's summary assertion. T26, the zero-entry
 * listing, is a fixture for a shape the gate must classify, not a mutant
 * killer.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * T21's previous path. Named for the same reason as T7's: the case's whole
 * discriminating power is that this path lies outside `FRAGMENT_PATH`, so an
 * exemption test comparing basename stems alone would exempt the rename.
 */
const T21_NON_FRAGMENT_PREVIOUS = "docs/notes/31.md";

/** The workflow command T22's hostile filename tries to put on the annotation surface. */
const T22_FORGED_COMMAND = "::error::forged annotation";

/**
 * T22's filename, carrying a real line feed. The listing is attacker-supplied
 * — a contributor names the files in their own PR — so a value that reaches
 * an annotation must not be able to open a second workflow command.
 */
const T22_HOSTILE_FILENAME = `changelog_unreleased/fixed/99.md\n${T22_FORGED_COMMAND}`;

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
 * the per-arm remediations; T10 holds every blocking fixture to it. `Usage:`
 * is the invocation arms' remediation: for a malformed call the live act is
 * re-issuing the call correctly, and the usage line is what states it.
 */
const REMEDIATION = /skip-changelog|re-run|Rename the file|Closes|TEMPLATE\.md|Usage:/;

interface FileEntry {
	filename: string;
	/**
	 * Optional, because a partial entry — one the platform sent with no
	 * `status` key — is a shape the gate has to classify rather than
	 * misread. T24 is the only case that omits it.
	 */
	status?: string;
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
	/**
	 * stdin verbatim, used instead of the serialization of `pages`. The two
	 * arms that run before the payload is parsed are reached only by input
	 * that is not a listing at all, which `pages` cannot express.
	 */
	rawStdin?: string;
	expectedCount: number;
	/** Whitespace-separated allow-set in one argument: PR number ∪ closing issues. */
	allowed: string;
	pr: number;
	/** Exit 1 expected — the set T10 sweeps. */
	expectBlock: boolean;
	/**
	 * Raw argv tokens appended after the standard argument set. The argument
	 * loop's own arms — a trailing flag with no value, an overwritten earlier
	 * value — are reached only by an argv the standard set cannot express.
	 */
	extraArgs?: string[];
	/**
	 * Omit the `--allowed` pair from the argv entirely. Not the same seam as
	 * `extraArgs`: an absent flag and a flag with an empty value take
	 * different paths through the argument loop.
	 */
	omitAllowed?: boolean;
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
	// single `renamed` entry whose stem is unchanged — and which of the two
	// arrives is the platform's choice, not the gate's. The exemption is
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
	{
		id: "T16",
		// Stem 44 is in the allow-set and the path is deliberately absent from
		// `files`, so presence is its only defect: this is the fixture that
		// enters the missing-file arm. T8 cannot — a `removed` entry is
		// filtered by status at both clause loops before any read.
		summary: "an added fragment listed but absent from the checkout is refused for its absence",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
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
		id: "T17",
		// Valid JSON of the wrong shape: `.[][]` cannot iterate a string, so
		// the extraction fails while the payload is neither empty nor blank.
		summary: "stdin that is not the paginated shape is refused as unclassifiable, not as missing",
		files: {},
		pages: [],
		rawStdin: '{"not":"the paginated shape"}',
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T18",
		// The path shape admits `[0-9]+`, so a leading zero reaches the gate as
		// a well-formed fragment path. Stem `043` is outside the allow-set as
		// every leading-zero stem is — the allow-set is built from PR and issue
		// numbers — so the case asserts WHICH rule refuses it, not merely that
		// something does.
		summary: "an added fragment whose stem carries a leading zero is refused for its stem shape",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/fixed/043.md": "- A user-observable change worth one line. (#043)\n",
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: "changelog_unreleased/fixed/043.md", status: "added" },
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T19",
		// T8's shape with the path PRESENT at --root. That difference is the
		// whole case: with the file absent, "a removed entry is not a witness"
		// and "the file could not be read" produce the same refusal, so only
		// this fixture measures clause 1's status set.
		summary: "a removed entry is no witness even when its path is present at --root",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "removed" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T20",
		// The exemption's ceiling. Stem 31 is exempt from the allow-set rule by
		// the `removed` half of the same move, and its content is garbage: an
		// exemption that waived every rule would carry an arbitrary rewrite of
		// an already-merged fragment past clause 2 under cover of a move.
		summary: "a fragment exempted by a paired removal is still content-validated",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/fixed/31.md": "Not a bullet at all (#31)\n",
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: "changelog_unreleased/fixed/31.md", status: "added" },
				{ filename: "changelog_unreleased/added/31.md", status: "removed" },
			],
		],
		expectedCount: 3,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T21",
		// The exemption's entry condition. A rename into changelog_unreleased/
		// from outside it was never validated by this gate, so it is an
		// addition and carries an addition's burden. The content is valid and
		// stem 31 is outside the allow-set, so the allow-set rule is the sole
		// defect and the exemption is the only thing that could waive it.
		summary: "a rename whose previous path is not a fragment is not exempt from the allow-set rule",
		files: {
			"changelog_unreleased/fixed/43.md": validBullet(43),
			"changelog_unreleased/fixed/31.md": validBullet(31),
		},
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{
					filename: "changelog_unreleased/fixed/31.md",
					status: "renamed",
					previous_filename: T21_NON_FRAGMENT_PREVIOUS,
				},
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T22",
		// A filename carrying a real line feed. Escaped, it is not of fragment
		// shape, so it is an ordinary non-fragment entry and the run turns on
		// the valid 43 fragment alone — which is the point: the line feed
		// reaches neither an annotation nor a second listing row.
		summary: "a filename carrying a line feed puts no second workflow command on the annotation surface",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [
			[
				{ filename: "changelog_unreleased/fixed/43.md", status: "added" },
				{ filename: T22_HOSTILE_FILENAME, status: "added" },
			],
		],
		expectedCount: 2,
		allowed: "43",
		pr: 43,
		expectBlock: false,
	},
	{
		id: "T23",
		// Blank but not empty. jq reads a whitespace-only document as no
		// document at all and exits 0, so the listing and the length both come
		// back blank; an arm testing emptiness literally would pass this
		// through and let the truncation arm assert a partial view of a
		// listing the gate never read.
		summary: "a whitespace-only payload is refused as an unread listing, not as a truncated one",
		files: {},
		pages: [],
		rawStdin: "   \n",
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T24",
		// An entry the platform sent with no `status` key: the TSV row's
		// leading field is empty. Tab is IFS whitespace, so a positional read
		// elides that field and shifts every later one left — which names the
		// filename as the bad status and the status as an empty filename.
		summary: "an entry with no status names the empty status and the filename it belongs to",
		files: {},
		pages: [[{ filename: "changelog_unreleased/fixed/43.md" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T25",
		// The bullet and the (#N) reference must co-occur on ONE line. Two
		// line-independent checks admit this shape: `^- ` matches line 1 and
		// `(#43)` appears on line 2, so each passes on its own while the
		// fragment carries no conforming bullet at all.
		summary: "a bullet and a (#N) reference on separate lines do not satisfy the same-line rule",
		files: { "changelog_unreleased/fixed/43.md": "- the bullet, with no reference\n(#43)\n" },
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "added" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T26",
		// `[[]]` is one page with zero entries — the shape the platform returns
		// for a PR whose net diff is empty, and the workflow's fetch predicate
		// deliberately admits it so the script can be the one that decides.
		summary: "a listing document carrying no entries leaves the floor unmet",
		files: {},
		pages: [[]],
		expectedCount: 0,
		allowed: "43",
		pr: 43,
		expectBlock: true,
	},
	{
		id: "T27",
		// The trailing `--pr` carries no value (#49 weakening 1). An
		// unconditional two-argument shift dies here under `set -e` before the
		// required-args arm can speak, producing exit 1 with an EMPTY stderr —
		// the one thing the exit contract forbids. Only the guarded second
		// shift reaches the arm that names the omission.
		summary: "a trailing flag with no value is refused with the omission named, never silently",
		files: {},
		pages: [],
		rawStdin: "unread: the argument arms exit before stdin is touched",
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
		extraArgs: ["--pr"],
	},
	{
		id: "T28",
		// `--allowed` never given at all (#49 weakening 3). An absent allow-set
		// is not an empty one: without `--allowed` in the required-args arm the
		// gate proceeds, every stem fails the allow-set rule, and the refusal
		// blames the author for a transport-shaped omission with two
		// recoveries (rename / update Closes) that cannot clear it. The
		// fragment here is valid and in a well-formed listing precisely so
		// that, under that weakening, the run reaches the wrong-blame arm this
		// case forbids.
		summary: "an omitted --allowed is refused as the caller's omission, not blamed on the author's stem",
		files: { "changelog_unreleased/fixed/43.md": validBullet(43) },
		pages: [[{ filename: "changelog_unreleased/fixed/43.md", status: "added" }]],
		expectedCount: 1,
		allowed: "43",
		pr: 43,
		expectBlock: true,
		omitAllowed: true,
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
	const root = mkdtempSync(join(tmpdir(), `gitjig-changelog-${spec.id}-`));
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
		...(spec.omitAllowed === true ? [] : ["--allowed", spec.allowed]),
		"--root",
		root,
		...(spec.extraArgs ?? []),
	];
	const options = { input: spec.rawStdin ?? JSON.stringify(spec.pages), encoding: "utf8" as const };
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

/**
 * The stderr lines the platform reads as workflow commands. A command is
 * recognized at the start of a line, so the count of these lines is the size
 * of the annotation surface a run produced.
 */
function workflowCommandLines(result: GateResult): string[] {
	return result.stderr.split("\n").filter((line) => line.startsWith("::error"));
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

	/**
	 * Pinned here by name rather than via T10's union (#49 weakening 4): a
	 * message naming re-running alone also matches that union's `re-run`, so
	 * only an assertion on the enum-extension recovery itself can separate
	 * the two — and narrowing the union instead would strip `re-run` from
	 * arms (truncation, fetch) for which re-running IS the whole recovery.
	 */
	it("names the enum-extension recovery, which re-running can never substitute for", () => {
		assert.match(resultOf("T7").stderr, /add the status to the known set/);
	});

	it("is distinguishable from the clause-1 refusal", () => {
		assert.doesNotMatch(resultOf("T7").stderr, NO_FRAGMENT);
	});
});

// T8's payload never enters the presence check: `removed` is filtered by
// status at both clause loops, so its last assertion below is a statement
// about clause 1's refusal text and not about the missing-file arm. T16 is
// the case that drives that arm.
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

	/**
	 * Asserted on THIS case because its offender is a rename (#49 weakening
	 * 5): a summary narrowed back to "added" would tell the author of exactly
	 * this refusal that a rule for added files caught them, while the loop it
	 * summarises also covers renamed and copied entries.
	 */
	it("summarises the clause over every status the loop covers, not added alone", () => {
		assert.match(resultOf("T9").stderr, /Every added, renamed or copied fragment/);
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

describe("T16 — an added fragment listed but absent from the checkout", () => {
	it("blocks", () => {
		assert.equal(resultOf("T16").status, 1);
	});

	it("names absence from the checkout as the defect", () => {
		assert.match(resultOf("T16").stderr, /not present in the checkout/);
	});

	it("does not let grep's own failure out in place of the reason", () => {
		assert.doesNotMatch(resultOf("T16").stderr, /No such file/i);
	});
});

describe("T17 — stdin that is valid JSON of the wrong shape", () => {
	it("blocks", () => {
		assert.equal(resultOf("T17").status, 1);
	});

	it("names the extraction, not the counting, as what failed", () => {
		assert.match(resultOf("T17").stderr, /could not be classified/);
	});

	it("is distinguishable from the clause-1 refusal", () => {
		assert.doesNotMatch(resultOf("T17").stderr, NO_FRAGMENT);
	});
});

describe("T18 — an added fragment whose stem carries a leading zero", () => {
	it("blocks", () => {
		assert.equal(resultOf("T18").status, 1);
	});

	it("refuses it for the stem shape, not for the allow-set", () => {
		assert.match(resultOf("T18").stderr, /no leading zero/);
	});

	it("names the offending stem on stderr", () => {
		assert.match(resultOf("T18").stderr, /043/);
	});
});

describe("T19 — a removed fragment whose path is present at --root (clause 1)", () => {
	it("blocks: a removed entry is not a witness, however the checkout looks", () => {
		assert.equal(resultOf("T19").status, 1);
	});

	it("refuses in clause-1 terms", () => {
		assert.match(resultOf("T19").stderr, NO_FRAGMENT);
	});
});

describe("T20 — a fragment exempted by a paired removal, with garbage content (clause 2)", () => {
	it("blocks: the exemption waives the allow-set rule and nothing else", () => {
		assert.equal(resultOf("T20").status, 1);
	});

	it("names the bullet form as the defect", () => {
		assert.match(resultOf("T20").stderr, /single-line markdown bullet/);
	});

	it("does not refuse the exempt stem for the allow-set: the waiver still holds", () => {
		assert.doesNotMatch(resultOf("T20").stderr, /neither this PR's number/);
	});
});

describe("T21 — a rename whose previous path was never a fragment (clause 2)", () => {
	it("renames from outside the fragment tree: the case measures the exemption's entry condition", () => {
		assert.doesNotMatch(T21_NON_FRAGMENT_PREVIOUS, FRAGMENT_PATH);
	});

	it("blocks", () => {
		assert.equal(resultOf("T21").status, 1);
	});

	it("names the allow-set rule for the renamed-to stem", () => {
		assert.match(resultOf("T21").stderr, /stem '31' is neither this PR's number/);
	});
});

describe("T22 — a filename carrying a line feed", () => {
	it("carries a real line feed: the case measures escaping, not path shape", () => {
		assert.match(T22_HOSTILE_FILENAME, /\n/);
	});

	it("opens no workflow command at all on this run", () => {
		assert.equal(workflowCommandLines(resultOf("T22")).length, 0);
	});

	it("puts no forged command on the annotation surface", () => {
		assert.ok(
			!workflowCommandLines(resultOf("T22")).some((line) => line.startsWith(T22_FORGED_COMMAND)),
		);
	});
});

describe("T23 — a whitespace-only payload on stdin", () => {
	it("blocks", () => {
		assert.equal(resultOf("T23").status, 1);
	});

	it("names the transport, not the author", () => {
		assert.match(resultOf("T23").stderr, /transport failure/);
	});

	it("is distinguishable from the truncation refusal", () => {
		assert.doesNotMatch(resultOf("T23").stderr, /incomplete/i);
	});
});

describe("T24 — an entry the platform sent with no status", () => {
	it("blocks", () => {
		assert.equal(resultOf("T24").status, 1);
	});

	it("names the empty status and the filename it belongs to, in that order", () => {
		assert.match(
			resultOf("T24").stderr,
			/Unrecognized file status '' for 'changelog_unreleased\/fixed\/43\.md'/,
		);
	});
});

/**
 * S1 — the empty-payload arm's FORM, pinned structurally (#49 weakening 2).
 *
 * The `case` arm and the whole-payload substitution
 * (`${payload//[[:space:]]/}`) have identical truth tables, so no
 * stdin-driven fixture can separate them; they differ in whether the script
 * returns at all on a listing of real size, and a wall-clock assertion is a
 * false-red class. The deterministic proxy is the script's own text: the
 * substitution token must not appear in code. The script's commentary NAMES
 * the rejected form while explaining the decision, so the scan runs over a
 * comment-stripped view — over the raw bytes the absence assertion would be
 * vacuously red.
 */
describe("S1 — the empty-payload arm short-circuits instead of rebuilding the payload", () => {
	const codeLines = readFileSync(SCRIPT, "utf8")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line));

	it("keeps the whole-payload substitution out of the code: its only mention is commentary", () => {
		assert.deepEqual(codeLines.filter((line) => line.includes("payload//")), []);
	});

	it("tests the payload with a case arm, which stops at the first non-space byte", () => {
		assert.equal(codeLines.filter((line) => /^\s*case "\$payload" in/.test(line)).length, 1);
	});
});

describe("T26 — a listing document carrying no entries", () => {
	it("blocks", () => {
		assert.equal(resultOf("T26").status, 1);
	});

	it("refuses in clause-1 terms: an empty net diff has no witness", () => {
		assert.match(resultOf("T26").stderr, NO_FRAGMENT);
	});

	it("offers the skip label as the live remediation", () => {
		assert.match(resultOf("T26").stderr, SKIP_LABEL);
	});

	it("is distinguishable from the empty-payload transport refusal: the listing WAS read", () => {
		assert.doesNotMatch(resultOf("T26").stderr, /transport failure/);
	});
});

describe("T27 — a trailing flag given without its value", () => {
	it("blocks", () => {
		assert.equal(resultOf("T27").status, 1);
	});

	it("names the omitted arguments on stderr: exit 1 with an empty stderr is outside the contract", () => {
		assert.match(resultOf("T27").stderr, /--pr, --expected-count and --allowed are all required/);
	});
});

describe("T28 — --allowed never given", () => {
	it("blocks", () => {
		assert.equal(resultOf("T28").status, 1);
	});

	it("names the omission in required-arguments terms", () => {
		assert.match(resultOf("T28").stderr, /--pr, --expected-count and --allowed are all required/);
	});

	it("does not blame the author's stem for the caller's omission", () => {
		assert.doesNotMatch(resultOf("T28").stderr, /neither this PR's number/);
	});
});

describe("T25 — a bullet and its reference on separate lines", () => {
	it("blocks", () => {
		assert.equal(resultOf("T25").status, 1);
	});

	it("names the same-line requirement, not the missing bullet", () => {
		assert.match(resultOf("T25").stderr, /on the SAME line/);
	});
});
