/**
 * Structural closure check for the project-name retirement (issue #75).
 *
 * Subject under test: the tracked surface of THIS repository — the bytes git
 * has under version control, and the path names git has under version
 * control. The Doc phase moved the contract (SPEC §2.5's two-namespace rule
 * and the README title now name the new namespace); this suite is the
 * closure check that the move actually reached every tracked surface rather
 * than the two files the Doc commit touched.
 *
 * The retired token is the five-letter former project name, in three
 * casings: all-lower, all-upper, and initial-capital. Those three are the
 * spellings the tracked tree actually uses (identifier prefixes, environment
 * variable prefixes, directory names, prose); the scan is exactly those
 * three and claims nothing about any other casing.
 *
 * TWO SURFACES, AND WHY BOTH. A content reader alone does not close the
 * question. Measured on the Doc-phase tree (`git grep -ci` per path):
 * `.pi/extensions/<retired>/quote.ts` carries the token in its PATH and
 * ZERO times in its bytes, so no content scan can ever reach it. The path
 * arm is therefore load-bearing, not decorative.
 *
 * THE SELF-REFERENCE CONSTRAINT, AND HOW IT IS SOLVED. This file is itself
 * a tracked file, so a literal spelling of the retired token anywhere in it
 * would make the content arm report this suite forever. The token is
 * therefore BUILT AT RUN TIME from codepoint constants and never written
 * literally — the same construction `secret-scan.githook.test.ts` uses for
 * its planted secrets, and for the same reason: the asserted byte sequence
 * must exist only at run time. The alternative — adding this file's own path
 * to the exclusion set — is refused on purpose: an exclusion set that opens
 * with the checker is an exclusion set that grows.
 *
 * THE EXCLUSION SET IS DATA, NOT AN OPEN ALLOWLIST. Exactly one tree is
 * excluded from the CONTENT arm, declared below with its ground:
 * `changelog_unreleased/`. SPEC §1.3 requires a changelog fragment per
 * change, and this change's fragment must NAME what was retired; SPEC
 * §2.5(d) covers that record purpose. A record of a retirement is not a
 * survival of it. The exclusion is enumerated in one place as data, carries
 * its justification in place, and the arm below asserts it is non-vacuous —
 * an exclusion that matches nothing is a rule nobody is applying.
 *
 * The PATH arm has no exclusion set at all: no tracked path under
 * `changelog_unreleased/` carries the token (measured on the Doc-phase
 * tree), so the record carve-out needs no path-side counterpart, and
 * granting one would create the open allowlist the content side avoids.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only shape). Every
 * assertion below is a claim about the tracked tree as `git ls-files`
 * reports it, and nothing more. A green run does NOT establish:
 *
 *   1. That untracked working-tree files, git history, remote artifacts
 *      (issues, PR bodies, releases), or any operator's local state are
 *      free of the token. `git ls-files` sees none of those.
 *   2. That the rename is semantically complete. The scan is lexical: a
 *      surface renamed to a DIFFERENT wrong name passes here.
 *   3. That casings outside the declared three are absent — a mixed casing
 *      is out of the scan's stated domain, not asserted absent.
 *   4. That a tracked file unreadable at scan time is clean. Such a file
 *      is reported as its own violation shape rather than skipped, so the
 *      residual is a red, not a silence.
 *
 * The scanners' own teeth are pinned by the synthetic-mutant arms at the
 * bottom (§3.12 — a guard the suite never measures is decoration): one
 * mutant per surface, plus the clean-input companion that keeps a
 * report-everything scanner from passing for the report-something reason.
 *
 * This suite runs `git ls-files` and reads tracked files from disk. It
 * writes nothing: no network, no `gh`, no `pi`, no fixture.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const cp = String.fromCharCode;

/**
 * The retired five-letter project name, assembled from codepoints — never
 * literal in this source (header note: this file is itself tracked, and a
 * literal would make the content arm report the checker forever).
 */
const RETIRED = cp(0x67, 0x68, 0x6a, 0x69, 0x67);

/** The three declared casings: all-lower, all-upper, initial-capital. */
const CASINGS: readonly string[] = [
	RETIRED,
	RETIRED.toUpperCase(),
	RETIRED.slice(0, 1).toUpperCase() + RETIRED.slice(1),
];

/**
 * The CONTENT arm's exclusion set — enumerated data, one entry, each with
 * the ground that admits it (header note). Nothing is added here without
 * that ground, and the checker's own path is never a member.
 */
const CONTENT_EXCLUSIONS: readonly { prefix: string; why: string }[] = [
	{
		prefix: "changelog_unreleased/",
		why:
			"SPEC §2.5(d)'s record-purpose carve-out: SPEC §1.3 requires a fragment per change, and this " +
			"change's fragment must name what was retired — a record of a retirement is not a survival of it",
	},
];

/** One reported occurrence: which tracked path, and which casing was found. */
interface Occurrence {
	path: string;
	casing: string;
}

function isExcludedFromContent(path: string): boolean {
	return CONTENT_EXCLUSIONS.some((entry) => path.startsWith(entry.prefix));
}

/**
 * Every declared casing occurring in a tracked PATH NAME. Injected paths,
 * not read from git here, so the mutant arms below call the same predicate
 * the real arm calls — one predicate, two call sites (§3.11).
 */
function pathViolations(paths: readonly string[]): Occurrence[] {
	const found: Occurrence[] = [];
	for (const path of paths) {
		for (const casing of CASINGS) {
			if (path.includes(casing)) {
				found.push({ path, casing });
			}
		}
	}
	return found;
}

/**
 * Every declared casing occurring in tracked file BYTES. Content is matched
 * at byte fidelity (`Buffer.includes`), so a non-UTF-8 tracked file is
 * measured rather than mangled by a decode.
 */
function contentViolations(files: readonly { path: string; bytes: Buffer }[]): Occurrence[] {
	const found: Occurrence[] = [];
	for (const file of files) {
		for (const casing of CASINGS) {
			if (file.bytes.includes(Buffer.from(casing, "utf8"))) {
				found.push({ path: file.path, casing });
			}
		}
	}
	return found;
}

/** The tracked path set, read from git itself (NUL-delimited: any path byte is safe). */
function trackedPaths(): string[] {
	const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot(), maxBuffer: 64 * 1024 * 1024 });
	assert.equal(result.status, 0, `git ls-files failed: ${(result.stderr ?? Buffer.alloc(0)).toString("utf8")}`);
	return (result.stdout ?? Buffer.alloc(0))
		.toString("utf8")
		.split("\0")
		.filter((path) => path !== "");
}

/**
 * The bytes of every tracked path outside the content exclusion set. A path
 * git tracks but the worktree cannot deliver (deleted, or unreadable) is
 * surfaced as its own failure rather than skipped: a silent skip is a hole
 * in a closure check.
 */
function readableTrackedFiles(paths: readonly string[]): {
	files: { path: string; bytes: Buffer }[];
	unreadable: string[];
} {
	const files: { path: string; bytes: Buffer }[] = [];
	const unreadable: string[] = [];
	for (const path of paths) {
		if (isExcludedFromContent(path)) {
			continue;
		}
		const absolute = join(repoRoot(), ...path.split("/"));
		try {
			if (!statSync(absolute).isFile()) {
				continue; // a gitlink/submodule entry has no bytes of its own here
			}
			files.push({ path, bytes: readFileSync(absolute) });
		} catch {
			unreadable.push(path);
		}
	}
	return { files, unreadable };
}

function render(found: readonly Occurrence[]): string {
	return JSON.stringify(
		found.map((occurrence) => `${occurrence.path} :: ${occurrence.casing}`),
		null,
		2,
	);
}

describe("the retired project name survives on no tracked surface (issue #75, SPEC §2.5)", () => {
	it("no tracked path NAME carries the retired token in any declared casing", () => {
		// Load-bearing, not decorative (header note): the one path measured
		// with ZERO content occurrences is reachable ONLY here.
		const found = pathViolations(trackedPaths());
		assert.equal(
			found.length,
			0,
			`${found.length} tracked path name(s) still carry the retired project name — a rename that moves ` +
				`file bytes but leaves the directory and file names behind has not moved the namespace ` +
				`(issue #75). Rename each with 'git mv': ${render(found)}`,
		);
	});

	it("no tracked file CONTENT carries the retired token in any declared casing", () => {
		const paths = trackedPaths();
		const { files, unreadable } = readableTrackedFiles(paths);
		assert.deepEqual(
			unreadable,
			[],
			"a tracked path could not be read, so the closure check did not measure it — a skipped file is a " +
				"hole in a closure claim, never a pass",
		);
		const found = contentViolations(files);
		assert.equal(
			found.length,
			0,
			`${found.length} occurrence(s) of the retired project name survive in tracked file bytes — the ` +
				`Doc phase moved the contract, so every remaining spelling is a surface the contract no longer ` +
				`describes (issue #75): ${render(found)}`,
		);
	});

	it("the content exclusion set is non-vacuous — it excuses paths that exist", () => {
		// An exclusion nobody's tree matches is a rule nobody is applying: it
		// would sit here reading as a granted carve-out while silently
		// excusing nothing, and would keep reading that way after the tree
		// moved out from under it.
		const paths = trackedPaths();
		for (const entry of CONTENT_EXCLUSIONS) {
			assert.equal(
				paths.some((path) => path.startsWith(entry.prefix)),
				true,
				`the content exclusion '${entry.prefix}' matches no tracked path — remove it, or fix the prefix`,
			);
		}
	});
});

describe("the closure check's own teeth (§3.12 — a guard the suite never measures is decoration)", () => {
	// The token is assembled here exactly as above: these synthetic inputs
	// carry the byte sequence only at run time.

	it("reports a synthetic PATH name carrying the token, and admits a clean one", () => {
		assert.deepEqual(pathViolations([`.pi/extensions/${RETIRED}/quote.ts`]), [
			{ path: `.pi/extensions/${RETIRED}/quote.ts`, casing: RETIRED },
		]);
		assert.deepEqual(pathViolations([".pi/extensions/renamed/quote.ts"]), []);
	});

	it("reports synthetic CONTENT carrying the token, and admits clean content", () => {
		const dirty = Buffer.from(`export const sink = ".${RETIRED}/state";`, "utf8");
		assert.deepEqual(contentViolations([{ path: "synthetic.ts", bytes: dirty }]), [
			{ path: "synthetic.ts", casing: RETIRED },
		]);
		const clean = Buffer.from('export const sink = ".renamed/state";', "utf8");
		assert.deepEqual(contentViolations([{ path: "synthetic.ts", bytes: clean }]), []);
	});

	it("reports the upper and initial-capital casings, not only the lower one", () => {
		const upper = RETIRED.toUpperCase();
		const initialCap = RETIRED.slice(0, 1).toUpperCase() + RETIRED.slice(1);
		assert.deepEqual(contentViolations([{ path: "s.ts", bytes: Buffer.from(`${upper}_ROOT`, "utf8") }]), [
			{ path: "s.ts", casing: upper },
		]);
		assert.deepEqual(pathViolations([`docs/${initialCap}Notes.md`]), [
			{ path: `docs/${initialCap}Notes.md`, casing: initialCap },
		]);
	});

	it("the content exclusion excuses a path under the excluded tree and nothing beside it", () => {
		assert.equal(isExcludedFromContent("changelog_unreleased/changed/75.md"), true);
		assert.equal(isExcludedFromContent("SPEC.md"), false);
		// The checker's own path is NOT a member — the exclusion set may never
		// open with the checker (header note).
		assert.equal(isExcludedFromContent("test/name-retirement.structure.test.ts"), false);
	});
});
