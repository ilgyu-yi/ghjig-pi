/**
 * Structural suite for the command-layer section (issue #78, Directive #77;
 * SPEC §4.8 "The command layer" and the sites amended to point at it — the
 * subset this suite binds is the one arms 3–6 name).
 *
 * Subject under test: the TEXT of `SPEC.md`. The change under test appends
 * `### 4.8 The command layer` after §4.7 and amends the sites whose
 * obligations currently dangle on an object no section defines. Seven arms:
 *
 *   1. a `### 4.8 ` heading exists;
 *   2. §4.8 has a row in the generated table of contents;
 *   3. §3.4's body carries a §4.8 cross-reference (issue #78 AC, §1.2's
 *      work-order criterion names this arm by name);
 *   4. §3.2's tier-1 paragraph — the one that says extensions "can register
 *      commands" — carries a §4.8 pointer;
 *   5. §4.1's `.pi/` paragraph carries a §4.8 pointer;
 *   6. §4's intro paragraph enumerates §4.8 alongside its siblings;
 *   7. the §4.8 span records a measurement against a NAMED substrate version
 *      (issue #78's signal-3 criterion: the recorded measurement is that
 *      criterion's checkable residue, §2.4).
 *
 * A structural check over a prose file is the sanctioned shape here, not a
 * workaround: §2.5 — "Structural checks over prose files remain normal
 * tests." The arms are lexical scans over `SPEC.md`'s bytes; they run no
 * `pi`, build no fixture, and reach no network.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11: "A report-only check names the
 * property it does not establish, so a green report is never read as the
 * missing guarantee"). Every claim below is LEXICAL — about prose text —
 * and none is a claim about a live command layer. Specifically, a green run
 * does NOT establish:
 *
 *   1. That any command asset exists. Nothing here reads `.pi/`, and issue
 *      #78 puts authoring one out of scope; §4.8 can be fully green with the
 *      layer entirely unbuilt.
 *   2. That the surface-selection rule §4.8 states is CORRECT, COMPLETE, or
 *      USABLE — that it really returns one surface per required capability,
 *      that the substrate really offers the surfaces it names, or that its
 *      worked cases resolve. Those are judgments at review (§2.3), not
 *      properties of a matcher over text.
 *   3. That the recorded measurement is CURRENT. Arm 7 asserts the PRESENCE
 *      and SHAPE of a substrate-version token, never equality against the
 *      installed `pi --version`: a clone carrying a newer substrate would
 *      red on an equality arm with no defect present, and §3.12 rules that
 *      "a check that can false-red is a defect". Drift between the recorded
 *      version and the installed one is therefore invisible here — §4.8's
 *      own cannot-measure obligation, not this suite's, is what covers it.
 *   4. That the table of contents is FRESH. Arm 2 pins that a §4.8 row is
 *      PRESENT and nothing more. TOC freshness is the `toc-freshness` gate's
 *      predicate (`.github/workflows/check-toc.yml`, §3.3), and §3.11 binds
 *      ownership to the predicate: re-deriving it here would be a second
 *      implementation of a property another owner holds. Out of scope by
 *      OWNERSHIP, not by oversight — a stale line number in a present row
 *      passes here and is caught there.
 *
 * Disclosed fooling shapes of the matchers themselves:
 *
 *   5. Arms 3–6 bind at PARAGRAPH granularity, not sentence: splitting prose
 *      that carries `§4.8`, `.pi/` and `e.g.` into sentences is unreliable
 *      lexically, so the residual is that a pointer may sit in a neighbouring
 *      sentence of the right paragraph and still pass.
 *   6. The pointer matcher binds the exact token `§4.8`. A cross-reference
 *      spelled "section 4.8", or one that names the command layer in prose
 *      without the section token, is invisible.
 *   7. Arm 7 requires a three-part version adjacent to the substrate name
 *      (`pi 0.84.3`). A measurement recorded as a bare version, a two-part
 *      version, or against an unnamed substrate is invisible.
 *   8. The readers are line- and paragraph-lexical, not a Markdown parser: a
 *      `### 4.8 ` line inside a fenced code block would be read as a heading,
 *      and a table row inside the TOC markers is trusted to be a TOC row.
 *
 * The matchers' own teeth are pinned by the synthetic-mutant arms at the
 * bottom (§3.12): a green real-tree arm proves nothing unless the matcher
 * demonstrably reds on a tree that lacks the subject, so every matcher is
 * exercised in BOTH directions in-suite against synthetic strings.
 *
 * This suite reads one file and writes nothing: no network, no `gh`, no
 * `pi`, no fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

/** The one file under test. */
const SPEC = "SPEC.md";

/** The section this change introduces, and the sites amended to point at it. */
const COMMAND_LAYER = "4.8";

const TOC_START = "<!-- TOC START";
const TOC_END = "<!-- TOC END -->";

function readSpec(): string {
	return readFileSync(join(repoRoot(), SPEC), "utf8");
}

function escapeSection(section: string): string {
	return section.replace(/\./g, "\\.");
}

/**
 * The generated table of contents, marker to marker. Returns "" when either
 * marker is absent or they appear out of order — an unparseable TOC must
 * read as "no row found", never as a silently empty search space that greens
 * arm 2 by accident.
 */
function tocBlock(doc: string): string {
	const start = doc.indexOf(TOC_START);
	const end = doc.indexOf(TOC_END);
	if (start === -1 || end === -1 || end < start) {
		return "";
	}
	return doc.slice(start, end);
}

/**
 * Every TOC row whose SECTION cell (the first cell) names exactly `section`.
 * Binding to the first cell is what keeps a title cell that merely mentions
 * §4.8 from counting as §4.8's own row.
 */
function tocRowsFor(toc: string, section: string): string[] {
	const cell = new RegExp(`§${escapeSection(section)}(?!\\.?\\d)`);
	return toc
		.split("\n")
		.filter((line) => line.trimStart().startsWith("|"))
		.filter((line) => cell.test(line.split("|")[1] ?? ""));
}

/** `## 4. ` for a top-level section, `### 4.1 ` for a subsection. */
function headingPattern(section: string): RegExp {
	return section.includes(".")
		? new RegExp(`^### ${escapeSection(section)} \\S`)
		: new RegExp(`^## ${escapeSection(section)}\\. \\S`);
}

/**
 * The verdict function for arms 1 and 3–7 (§3.11: one predicate, many call
 * sites). Returns the section's heading line plus every line up to the next
 * `##`/`###` heading — so `sectionSpan(doc, "4")` is §4's INTRO alone, its
 * subsections excluded. Returns "" when the heading is absent, which is what
 * makes arm 1 and the span-scoped arms red together on the pre-change tree.
 */
function sectionSpan(doc: string, section: string): string {
	const lines = doc.split("\n");
	const open = headingPattern(section);
	const start = lines.findIndex((line) => open.test(line));
	if (start === -1) {
		return "";
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (/^#{2,3} /.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

/** A span's paragraphs, heading lines dropped. */
function bodyParagraphs(span: string): string[] {
	return span
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== "" && !paragraph.startsWith("#"));
}

/** The first body paragraph containing `needle`, or "" if none does. */
function paragraphWith(span: string, needle: string): string {
	return bodyParagraphs(span).find((paragraph) => paragraph.includes(needle)) ?? "";
}

/**
 * Does this text carry a cross-reference to exactly `section`? `§4.8` and
 * `§4.8.` (sentence-final) count; `§4.81` and `§4.8.1` do not — a longer
 * section that merely shares the prefix is a different section.
 */
function carriesPointer(text: string, section: string): boolean {
	return new RegExp(`§${escapeSection(section)}(?!\\.?\\d)`).test(text);
}

/**
 * Substrate-version tokens: a three-part version standing next to the
 * substrate's name (`pi 0.84.3`, `pi \`0.84.3\``, `pi v0.84.3`). Returns the
 * versions found. Adjacency to the NAME is the point — a bare `0.84.3` in
 * prose is a number, not a record of what was measured against what.
 */
function substrateVersionTokens(text: string): string[] {
	return [...text.matchAll(/\bpi[ \t]+`?v?(\d+\.\d+\.\d+)\b/g)].map((match) => match[1] ?? "");
}

describe("SPEC §4.8 command layer — structure (issue #78)", () => {
	it("the reader sees the document it claims to read (a mis-read SPEC would red every arm for the wrong reason)", () => {
		const spec = readSpec();
		assert.ok(
			tocRowsFor(tocBlock(spec), "4.7").length === 1 &&
				bodyParagraphs(sectionSpan(spec, "3.4")).length > 0 &&
				paragraphWith(sectionSpan(spec, "3.2"), "**Tier 1").includes("register commands") &&
				paragraphWith(sectionSpan(spec, "4.1"), "`.pi/`") !== "" &&
				bodyParagraphs(sectionSpan(spec, "4")).length > 0,
			"the readers lost a landmark that exists on the pre-change tree (§4.7's TOC row, §3.4's body, §3.2's " +
				"tier-1 paragraph naming command registration, §4.1's `.pi/` paragraph, §4's intro) — the arms below " +
				"would then red because this suite cannot read SPEC.md, not because the subject is absent",
		);
	});

	it("a §4.8 heading exists", () => {
		assert.notEqual(
			sectionSpan(readSpec(), COMMAND_LAYER),
			"",
			`SPEC.md carries no \`### ${COMMAND_LAYER} \` heading — the four sites that place obligations on a ` +
				"command asset (§2.5, §2.7, §2.8, §3.2) still dangle on an object no section defines. Append the " +
				"command-layer section after §4.7 (issue #78).",
		);
	});

	it("§4.8 has a row in the generated table of contents", () => {
		assert.equal(
			tocRowsFor(tocBlock(readSpec()), COMMAND_LAYER).length,
			1,
			`the table of contents has no §${COMMAND_LAYER} row, so the section is unreachable by the targeted-read ` +
				"convention §0.3 states. Regenerate the contents in the same commit " +
				"(`.github/workflows/build_toc.sh`); freshness of the row is the `toc-freshness` gate's business, " +
				"not this suite's.",
		);
	});

	it("§3.4 carries a §4.8 cross-reference", () => {
		assert.ok(
			carriesPointer(bodyParagraphs(sectionSpan(readSpec(), "3.4")).join("\n"), COMMAND_LAYER),
			`§3.4 names tier 1's substrate-specific residual for gate classes but does not point at §${COMMAND_LAYER}, ` +
				"so what a different agent harness loses on the OPERATOR surface stays undiscoverable (MISSION " +
				'§ "Agent-agnosticism"). Add the cross-reference to §3.4 (issue #78, §3.4 amendment).',
		);
	});

	it("§3.2's tier-1 paragraph points at §4.8", () => {
		assert.ok(
			carriesPointer(paragraphWith(sectionSpan(readSpec(), "3.2"), "**Tier 1"), COMMAND_LAYER),
			`§3.2's tier-1 paragraph records that extensions "can register commands" and points nowhere — a ` +
				`capability with no section stating what may ride it. Point it at §${COMMAND_LAYER} (issue #78 ` +
				"records §3.2 as a decision either way, never a silent omission).",
		);
	});

	it("§4.1's `.pi/` paragraph points at §4.8", () => {
		assert.ok(
			carriesPointer(paragraphWith(sectionSpan(readSpec(), "4.1"), "`.pi/`"), COMMAND_LAYER),
			"§4.1 names `.pi/` as the substrate-native runtime namespace without saying that a command asset homes " +
				`there. Add the §${COMMAND_LAYER} pointer to the \`.pi/\` paragraph (issue #78 reach sweep).`,
		);
	});

	it("§4's intro paragraph enumerates §4.8", () => {
		assert.ok(
			carriesPointer(bodyParagraphs(sectionSpan(readSpec(), "4")).join("\n"), COMMAND_LAYER),
			`§4's intro enumerates its subsections and omits §${COMMAND_LAYER}; a section absent from its own ` +
				"parent's enumeration is reachable only by scrolling. Add it to the intro (issue #78 reach sweep).",
		);
	});

	it("§4.8 records a measurement against a named substrate version", () => {
		assert.ok(
			substrateVersionTokens(sectionSpan(readSpec(), COMMAND_LAYER)).length > 0,
			`§${COMMAND_LAYER} states no substrate version it measured the registration surfaces against, so a ` +
				"reader cannot tell whether the recorded surfaces were ever measured or against what — issue #78's " +
				'signal-3 criterion calls that record "this criterion\'s checkable residue" (§2.4). Record the ' +
				"measurement as `pi <major>.<minor>.<patch>`. This arm pins that a version is RECORDED; it never " +
				"pins that it is current (equality against the installed `pi --version` would false-red on a newer " +
				"clone — §3.12).",
		);
	});
});

describe("the suite's own teeth (§3.12 — both directions on synthetic documents)", () => {
	const SYNTHETIC = [
		"# SPEC",
		"",
		"<!-- TOC START — generated -->",
		"| Section | Title | Line |",
		"|---|---|---|",
		"| &nbsp;&nbsp;§4.7 | Host boundary | 536 |",
		"| &nbsp;&nbsp;§4.8 | The command layer | 544 |",
		"<!-- TOC END -->",
		"",
		"## 4. Substrate and install contract",
		"",
		"This intro enumerates §4.7 and §4.8.",
		"",
		"### 4.1 Namespaces",
		"",
		"The shell owns `.pi/` and `.gitjig/` (§4.8).",
		"",
		"A second paragraph naming `.githooks/helpers/` and nothing else.",
		"",
		"### 4.10 A decoy whose number merely starts with 4.1",
		"",
		"Nothing here belongs to §4.1.",
		"",
		"### 4.8 The command layer",
		"",
		"Measured against pi 0.84.3 on this date.",
		"",
		"## 5. Cross-cutting contracts",
		"",
		"Past the end of §4.8's span.",
	].join("\n");

	it("finds a §4.8 TOC row that is there", () => {
		assert.deepEqual(tocRowsFor(tocBlock(SYNTHETIC), "4.8"), ["| &nbsp;&nbsp;§4.8 | The command layer | 544 |"]);
	});

	it("finds no §4.8 TOC row on a contents that lacks one", () => {
		const withoutRow = SYNTHETIC.replace("| &nbsp;&nbsp;§4.8 | The command layer | 544 |\n", "");
		assert.deepEqual(tocRowsFor(tocBlock(withoutRow), "4.8"), []);
	});

	it("does not count a row that only MENTIONS §4.8 in its title cell", () => {
		assert.deepEqual(tocRowsFor("| &nbsp;&nbsp;§4.7 | Host boundary, see §4.8 | 536 |", "4.8"), []);
	});

	it("does not count a prefix-sharing row as §4.8's own", () => {
		assert.deepEqual(tocRowsFor("| &nbsp;&nbsp;§4.81 | Not this one | 900 |", "4.8"), []);
	});

	it("returns no TOC block when the markers are absent — an unparseable contents is not an empty pass", () => {
		assert.deepEqual(tocRowsFor(tocBlock("| &nbsp;&nbsp;§4.8 | The command layer | 544 |"), "4.8"), []);
	});

	it("returns no TOC block when the markers are out of order", () => {
		assert.equal(tocBlock(`${TOC_END}\n| &nbsp;&nbsp;§4.8 | x | 1 |\n${TOC_START} -->`), "");
	});

	it("spans a subsection from its heading to the next heading", () => {
		const span = sectionSpan(SYNTHETIC, "4.1");
		assert.ok(span.includes("`.gitjig/`") && span.includes("`.githooks/helpers/`") && !span.includes("decoy"));
	});

	it("spans a top-level section's INTRO only, excluding its subsections", () => {
		const span = sectionSpan(SYNTHETIC, "4");
		assert.ok(span.includes("This intro enumerates") && !span.includes("### 4.1"));
	});

	it("stops a span at the next top-level heading", () => {
		assert.ok(!sectionSpan(SYNTHETIC, "4.8").includes("Past the end"));
	});

	it("does not mistake §4.10's heading for §4.1's", () => {
		assert.ok(!sectionSpan(SYNTHETIC, "4.1").includes("A decoy"));
	});

	it("returns an empty span for a section that is absent — the pre-change shape every §4.8 arm reds on", () => {
		assert.equal(sectionSpan(SYNTHETIC.replace("### 4.8 The command layer", "### 4.9 Something else"), "4.8"), "");
	});

	it("selects the paragraph carrying the needle, not the whole span", () => {
		assert.ok(paragraphWith(sectionSpan(SYNTHETIC, "4.1"), "`.pi/`").includes("§4.8"));
	});

	it("selects no paragraph when none carries the needle", () => {
		assert.equal(paragraphWith(sectionSpan(SYNTHETIC, "4.1"), "**Tier 1"), "");
	});

	it("drops heading lines from a span's body paragraphs", () => {
		assert.deepEqual(bodyParagraphs(sectionSpan(SYNTHETIC, "4.8")), ["Measured against pi 0.84.3 on this date."]);
	});

	it("reports a §4.8 pointer, including a sentence-final one", () => {
		assert.ok(carriesPointer("a call site beneath §3.3 (§4.8)", "4.8") && carriesPointer("see §4.8.", "4.8"));
	});

	it("stays silent on a neighbouring section's pointer", () => {
		assert.equal(carriesPointer("§4.7 states the host boundary, and §4.9 does not exist", "4.8"), false);
	});

	it("stays silent on a section number that merely extends §4.8", () => {
		assert.equal(carriesPointer("§4.81 and §4.8.1 are other sections", "4.8"), false);
	});

	it("stays silent on a §4.8 pointer that sits in a paragraph the arm does not bind", () => {
		assert.equal(carriesPointer(paragraphWith(sectionSpan(SYNTHETIC, "4.1"), "`.githooks/helpers/`"), "4.8"), false);
	});

	it("reports a substrate version recorded beside the substrate's name", () => {
		assert.deepEqual(substrateVersionTokens("the surfaces were measured against pi 0.84.3 on 2026-09-04"), [
			"0.84.3",
		]);
	});

	it("reports a backticked and a v-prefixed version", () => {
		assert.deepEqual(substrateVersionTokens("pi `0.84.3` and pi v1.2.30"), ["0.84.3", "1.2.30"]);
	});

	it("stays silent on a version with no substrate name beside it", () => {
		assert.deepEqual(substrateVersionTokens("measured on 0.84.3, recorded here"), []);
	});

	it("stays silent on a substrate named with no version", () => {
		assert.deepEqual(substrateVersionTokens("measured against pi while authoring"), []);
	});

	it("stays silent on a two-part version — the disclosed shape residual", () => {
		assert.deepEqual(substrateVersionTokens("measured against pi 0.84"), []);
	});
});
