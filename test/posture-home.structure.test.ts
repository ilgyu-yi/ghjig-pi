/**
 * Structural suite for the fail-posture inventory home (issue #55 AC3;
 * SPEC §3.9 "One inventory, one home", §6.1's inventory rule).
 *
 * Subject under test: the text of every shipped enforcement source — the
 * tier-1 runtime under `.pi/extensions/`, the local tier under
 * `.githooks/` (including any file under `.githooks/helpers/`), and the
 * tier-3 instruments under `.github/workflows/` — with the one stated home,
 * `.pi/extensions/ghjig/postures.ts`, excluded. The roster is WALKED from
 * those three roots rather than enumerated per file, so a source added
 * tomorrow (a new helper, a new workflow) is scanned the day it lands and
 * cannot drift in unguarded (§3.10's structural-lock shape).
 *
 * The recognizer is lexical, over a comment-stripped view (TS block/line
 * comments for `.ts`; whole-line `#` comments for everything else — hooks,
 * helpers, workflow YAML and shell). It reports two shapes:
 *
 *   1. a posture ASSIGNMENT — `posture`, an optional closing quote, `:` or
 *      `=`, then an optionally quoted `open`/`closed` value — the shape a
 *      posture row takes in TS, JSON, YAML, or a shell assignment;
 *   2. any use of `PostureRow` — a second table built on the home's own row
 *      type is the loudest possible second home.
 *
 * Prose is what the comment-stripping exists for: every "posture" the
 * shipped sources write outside the home today sits in comments, and a
 * sentence like "the posture of this gate is closed" never matches shape 1
 * (no `:`/`=` between the word and the value).
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only rule: a check
 * names the property it does not establish). Disclosed fooling shapes:
 *
 *   1. A posture declared under a DIFFERENT key (`failMode: "closed"`,
 *      `onMiss = open`) is invisible — the recognizer binds to the word
 *      the SPEC and the home use, not to the concept.
 *   2. A posture VALUE built dynamically (`posture: pick(mode)`, a ternary)
 *      is invisible: shape 1 requires a literal `open`/`closed` at the
 *      declaration site.
 *   3. A `posture: "open"` inside a string literal (a message quoting the
 *      shape) is a false positive — this suite fails toward reporting, and
 *      the remedy is rewording the message, not allowlisting (the
 *      exemption set is deliberately empty).
 *   4. The comment-strippers are lexical, not parsers: a `#` or `//` inside
 *      a string that begins a line, or a declaration sharing a line with a
 *      trailing comment, can be mis-stripped — the same residual the
 *      warning-surface suite's strippers disclose.
 *   5. Enforcement sources outside the three walked roots (none exist
 *      today) are not scanned; a fourth root joins ROOTS by being named.
 *
 * The recognizer's own teeth are pinned by the synthetic-mutant arms at
 * the bottom (§3.12): a green real-tree arm proves nothing unless an
 * out-of-home mutant demonstrably reds, so both directions are exercised
 * in-suite against synthetic sources.
 *
 * This suite reads files and writes nothing: no network, no `gh`, no `pi`,
 * no fixture.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

/** The walked roots: every shipped enforcement source lives under one of these. */
const ROOTS = [join(".pi", "extensions"), ".githooks", join(".github", "workflows")] as const;

/** The one home §3.9 states; the only file excluded from the scan. */
const INVENTORY_HOME = join(".pi", "extensions", "ghjig", "postures.ts");

type SourceKind = "ts" | "hash";

function kindOf(relPath: string): SourceKind {
	return relPath.endsWith(".ts") ? "ts" : "hash";
}

function stripTsComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n");
}

function stripHashComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/**
 * The verdict function — one predicate, called by both the real-tree arm
 * and the mutant arms below (§3.11: one predicate, two call sites).
 * Returns every posture-declaration match in the comment-stripped view.
 */
function postureDeclarations(source: string, kind: SourceKind): string[] {
	const text = kind === "ts" ? stripTsComments(source) : stripHashComments(source);
	const found: string[] = [];
	for (const match of text.matchAll(/\bposture\b["']?\s*[:=]\s*["']?(open|closed)\b/g)) {
		found.push(match[0]);
	}
	for (const match of text.matchAll(/\bPostureRow\b/g)) {
		found.push(match[0]);
	}
	return found;
}

/** Recursive sorted walk; returns paths relative to the repo root. */
function walkFiles(relDir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		const entries = [...readdirSync(join(repoRoot(), rel), { withFileTypes: true })].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const childRel = join(rel, entry.name);
			if (entry.isDirectory()) {
				walk(childRel);
			} else {
				out.push(childRel);
			}
		}
	};
	walk(relDir);
	return out;
}

function rosterFiles(): string[] {
	return ROOTS.flatMap((root) => walkFiles(root)).filter((rel) => rel !== INVENTORY_HOME);
}

describe("posture-inventory home lock (SPEC §3.9, issue #55)", () => {
	it("the walk sees the tree it claims to scan (an empty roster would green vacuously)", () => {
		const roster = rosterFiles();
		assert.ok(
			roster.includes(join(".githooks", "commit-msg")) &&
				roster.includes(join(".pi", "extensions", "ghjig", "audit.ts")) &&
				!roster.includes(INVENTORY_HOME) &&
				roster.length >= 10,
			`roster lost a known enforcement source or shrank below plausibility: ${JSON.stringify(roster, null, 2)}`,
		);
	});

	it("the home itself is recognizable — a scan the home's own shape escapes is vacuous", () => {
		const declarations = postureDeclarations(readFileSync(join(repoRoot(), INVENTORY_HOME), "utf8"), "ts");
		assert.ok(
			declarations.length > 0,
			"the recognizer no longer sees a posture declaration in postures.ts — its shape drifted and this " +
				"suite is scanning for a shape the inventory does not use",
		);
	});

	it("no shipped enforcement source declares a posture outside the home", () => {
		const violations: string[] = [];
		for (const rel of rosterFiles()) {
			for (const declaration of postureDeclarations(readFileSync(join(repoRoot(), rel), "utf8"), kindOf(rel))) {
				violations.push(`${rel}: ${declaration}`);
			}
		}
		assert.equal(
			violations.length,
			0,
			`a posture is declared outside ${INVENTORY_HOME} — a second home for the property is §3.11's ` +
				`divergence surface, not redundancy. Move each row into the inventory (with its justification ` +
				`in place) and reference it from the source: ${JSON.stringify(violations, null, 2)}`,
		);
	});
});

describe("the lock's own teeth (§3.12 — both directions on synthetic sources)", () => {
	it("reports a TS posture row outside the home", () => {
		assert.deepEqual(
			postureDeclarations('const extra = { dependency: "x", posture: "closed", justification: "y" };', "ts"),
			['posture: "closed'],
		);
	});

	it("reports a YAML-shaped posture declaration", () => {
		assert.deepEqual(postureDeclarations("posture: closed\n", "hash"), ["posture: closed"]);
	});

	it("reports a shell-assignment posture declaration", () => {
		assert.deepEqual(postureDeclarations('posture=open\ncheck "$posture"\n', "hash"), ["posture=open"]);
	});

	it("reports a JSON-quoted posture key", () => {
		assert.deepEqual(postureDeclarations('{ "posture": "open" }', "ts"), ['posture": "open']);
	});

	it("reports a PostureRow use outside the home", () => {
		assert.deepEqual(postureDeclarations('import { PostureRow } from "./postures.ts";', "ts"), ["PostureRow"]);
	});

	it("stays silent on commented declarations", () => {
		assert.deepEqual(postureDeclarations('// posture: "closed" would be wrong here\n', "ts"), []);
		assert.deepEqual(postureDeclarations('/* posture: "open" discussed */', "ts"), []);
		assert.deepEqual(postureDeclarations("# posture=closed is the row's business\n", "hash"), []);
	});

	it("stays silent on prose that names the concept without declaring a value", () => {
		assert.deepEqual(postureDeclarations("the posture of this gate is closed by design", "ts"), []);
		assert.deepEqual(postureDeclarations("fail posture stays open on a missing helper", "hash"), []);
	});
});
