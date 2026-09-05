/**
 * Structural suite for the delegation-layer section (issue #81, Directive
 * #80; SPEC §4.9 "The delegation layer" and the sites amended to point at it
 * — the subset this suite binds is the one arms 4–7 and the intro arm name).
 *
 * Subject under test: the TEXT of `SPEC.md`. The change under test appends
 * `### 4.9 The delegation layer` after §4.8 and amends the sites that lean
 * on a dispatch object no section defines. The arms:
 *
 *   1. the reader arm — the extractors resolve landmarks that exist on the
 *      PRE-change tree (§4.8's TOC row; the three leaning-site phrases
 *      verbatim; §4's intro), so a red below means the subject is absent,
 *      never that the suite mis-reads the document;
 *   2. a `### 4.9 ` heading exists;
 *   3. §4.9 has exactly one row in the generated table of contents;
 *   4. §1.5's leaning paragraph — "the delegate roles are instruments that
 *      derive later" — carries a §4.9 pointer;
 *   5. §1.7's leaning paragraph — "the predicate and dispatch instruments
 *      derive later" — carries a §4.9 pointer;
 *   6. §1.8's leaning paragraph — the one assigning challenger axes
 *      "upstream by the dispatcher" — carries a §4.9 pointer;
 *   7. §4.8's span carries the reciprocal §4.9 pointer (issue #81 signal-2
 *      criterion: the boundary is drawn from both sides);
 *   8. the §4.9 span records a substrate-name-adjacent three-part version
 *      (issue #81 signal-1 criterion: the recorded measurement is that
 *      criterion's checkable residue, §2.4) AND carries the
 *      content-free-return sentence, pinned by a token pair;
 *   9. §4's intro paragraph enumerates §4.9 alongside its siblings.
 *
 * Arm 9 is a disclosed call: the caller's brief left the §4-intro
 * enumeration to this suite's judgment if it would duplicate arm 3. It does
 * not — arm 3 reads the generated TOC block between its markers and arm 9
 * reads §4's prose intro, disjoint text regions under disjoint matchers, the
 * same split the command-layer suite holds — so it stands as its own arm.
 *
 * A structural check over a prose file is the sanctioned shape here, not a
 * workaround: §2.5 — "Structural checks over prose files remain normal
 * tests." The arms are lexical scans over `SPEC.md`'s bytes; they run no
 * `pi`, build no fixture, and reach no network.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11: "A report-only check names the
 * property it does not establish, so a green report is never read as the
 * missing guarantee"). Every claim below is LEXICAL — about prose text —
 * and none is a claim about a live delegation layer. Specifically, a green
 * run does NOT establish:
 *
 *   1. That a dispatcher EXISTS. Lexical, not live: nothing here reads
 *      `.pi/`, dispatches a delegate, or provisions an isolated context, and
 *      issue #81's boundary puts authoring a dispatch instrument out of
 *      scope; §4.9 can be fully green with the layer entirely unbuilt.
 *   2. That the homing rule §4.9 states is CORRECT — that the substrate
 *      surface it selects really exists, really carries the isolation §1.5
 *      requires, or is usable at all. Those are judgments at review (§2.3),
 *      not properties of a matcher over text.
 *   3. That the recorded measurement is CURRENT. Arm 8 asserts the PRESENCE
 *      and SHAPE of a substrate-version token, never equality against the
 *      installed `pi --version`: a clone carrying a newer substrate would
 *      red on an equality arm with no defect present, and §3.12 rules that
 *      "a check that can false-red is a defect". Drift between the recorded
 *      version and the installed one is invisible here — §4.9's own
 *      drifted-substrate-reads-as-cannot-measure obligation, not this
 *      suite's, is what covers it.
 *   4. That the table of contents is FRESH. Arm 3 pins that a §4.9 row is
 *      PRESENT and nothing more. TOC freshness is the `toc-freshness` gate's
 *      predicate (`.github/workflows/check-toc.yml`, §3.3), and §3.11 binds
 *      ownership to the predicate: re-deriving it here would be a second
 *      implementation of a property another owner holds. Out of scope by
 *      OWNERSHIP, not by oversight.
 *   5. That any instrument HONORS the content-free-return sentence. Arm 8's
 *      token check pins that the sentence EXISTS in §4.9's prose — that the
 *      section states the bounded return stays content-free and never
 *      supplies the compare operand — never that a delegate's return is in
 *      fact content-free or that §1.6's blind compare is performed.
 *
 * Disclosed fooling shapes of the matchers themselves:
 *
 *   6. Arms 4–7 and 9 bind at PARAGRAPH (or span) granularity, not
 *      sentence: a pointer may sit in a neighbouring sentence of the right
 *      paragraph and still pass.
 *   7. The pointer matcher binds the exact token `§4.9`. A cross-reference
 *      spelled "section 4.9", or one that names the delegation layer in
 *      prose without the section token, is invisible.
 *   8. Arm 8's version matcher requires a three-part version adjacent to
 *      the substrate name (`pi 0.84.3`). A measurement recorded as a bare
 *      version, a two-part version, or against an unnamed substrate is
 *      invisible. Its sentence matcher is inflection-tolerant by design
 *      (`content-free`/`content free`, `compare`/`comparison operand(s)`)
 *      and killed by absence, so a paragraph inside §4.9 that carries both
 *      tokens while saying something else would pass, and a synonym pair
 *      the pattern does not spell (e.g. "opaque return") is invisible.
 *   9. The readers are line- and paragraph-lexical, not a Markdown parser:
 *      a `### 4.9 ` line inside a fenced code block would be read as a
 *      heading, and a table row inside the TOC markers is trusted to be a
 *      TOC row.
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
const DELEGATION_LAYER = "4.9";

/** The leaning-site phrases the amendments anchor on, verbatim from the pre-change tree. */
const LEAN_1_5 = "the delegate roles are instruments that derive later";
const LEAN_1_7 = "the predicate and dispatch instruments derive later";
const LEAN_1_8 = "upstream by the dispatcher";

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
 * arm 3 by accident.
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
 * §4.9 from counting as §4.9's own row.
 */
function tocRowsFor(toc: string, section: string): string[] {
	const cell = new RegExp(`§${escapeSection(section)}(?!\\.?\\d)`);
	return toc
		.split("\n")
		.filter((line) => line.trimStart().startsWith("|"))
		.filter((line) => cell.test(line.split("|")[1] ?? ""));
}

/** `## 4. ` for a top-level section, `### 4.9 ` for a subsection. */
function headingPattern(section: string): RegExp {
	return section.includes(".")
		? new RegExp(`^### ${escapeSection(section)} \\S`)
		: new RegExp(`^## ${escapeSection(section)}\\. \\S`);
}

/**
 * The verdict function for arms 2 and 4–9 (§3.11: one predicate, many call
 * sites). Returns the section's heading line plus every line up to the next
 * `##`/`###` heading — so `sectionSpan(doc, "4")` is §4's INTRO alone, its
 * subsections excluded. Returns "" when the heading is absent, which is what
 * makes arm 2 and the span-scoped arms red together on the pre-change tree.
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
 * Does this text carry a cross-reference to exactly `section`? `§4.9` and
 * `§4.9.` (sentence-final) count; `§4.91` and `§4.9.1` do not — a longer
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

/**
 * The first body paragraph carrying BOTH tokens of the content-free-return
 * sentence — `content-free` (or `content free`) and `compare operand` (any
 * inflection of `compare`, singular or plural operand) — or "" if none does.
 * One paragraph, both tokens: the sentence binds the bounded return to the
 * blind compare in one breath, and a suite that accepted the tokens spread
 * across the span would green on two unrelated sentences.
 */
function contentFreeReturnParagraph(span: string): string {
	return (
		bodyParagraphs(span).find(
			(paragraph) =>
				/content[ \t-]free/i.test(paragraph) && /\bcompar\w*[ \t-]+operands?\b/i.test(paragraph),
		) ?? ""
	);
}

describe("SPEC §4.9 delegation layer — structure (issue #81)", () => {
	it("the reader sees the document it claims to read (a mis-read SPEC would red every arm for the wrong reason)", () => {
		const spec = readSpec();
		assert.ok(
			tocRowsFor(tocBlock(spec), "4.8").length === 1 &&
				paragraphWith(sectionSpan(spec, "1.5"), LEAN_1_5) !== "" &&
				paragraphWith(sectionSpan(spec, "1.7"), LEAN_1_7) !== "" &&
				paragraphWith(sectionSpan(spec, "1.8"), LEAN_1_8) !== "" &&
				bodyParagraphs(sectionSpan(spec, "4")).length > 0,
			"the readers lost a landmark that exists on the pre-change tree (§4.8's TOC row; §1.5's delegate-roles " +
				"deferral, §1.7's dispatch-instruments deferral, and §1.8's dispatcher phrase, each verbatim; §4's " +
				"intro) — the arms below would then red because this suite cannot read SPEC.md, not because the " +
				"subject is absent",
		);
	});

	it("a §4.9 heading exists", () => {
		assert.notEqual(
			sectionSpan(readSpec(), DELEGATION_LAYER),
			"",
			`SPEC.md carries no \`### ${DELEGATION_LAYER} \` heading — §1.5's delegate roles, §1.7's dispatch ` +
				"instruments, and §1.8's dispatcher still lean on a dispatch object no section defines. Append the " +
				"delegation-layer section after §4.8 (issue #81, Directive #80).",
		);
	});

	it("§4.9 has exactly one row in the generated table of contents", () => {
		assert.equal(
			tocRowsFor(tocBlock(readSpec()), DELEGATION_LAYER).length,
			1,
			`the table of contents has no §${DELEGATION_LAYER} row, so the section is unreachable by the targeted-read ` +
				"convention §0.3 states. Regenerate the contents in the same commit " +
				"(`.github/workflows/build_toc.sh`); freshness of the row is the `toc-freshness` gate's business, " +
				"not this suite's.",
		);
	});

	it("§1.5's leaning paragraph points at §4.9", () => {
		assert.ok(
			carriesPointer(paragraphWith(sectionSpan(readSpec(), "1.5"), LEAN_1_5), DELEGATION_LAYER),
			`§1.5 defers "${LEAN_1_5}" and points nowhere — the delegate roles have no section stating where their ` +
				`dispatch homes. Point the deferral at §${DELEGATION_LAYER} (issue #81 signal-3 criterion), norm ` +
				"content untouched.",
		);
	});

	it("§1.7's leaning paragraph points at §4.9", () => {
		assert.ok(
			carriesPointer(paragraphWith(sectionSpan(readSpec(), "1.7"), LEAN_1_7), DELEGATION_LAYER),
			`§1.7 defers "${LEAN_1_7}" and points nowhere — the quorum's dispatch instruments have no section ` +
				`stating what they are. Point the deferral at §${DELEGATION_LAYER} (issue #81 signal-3 criterion), ` +
				"norm content untouched.",
		);
	});

	it("§1.8's dispatcher paragraph points at §4.9", () => {
		assert.ok(
			carriesPointer(paragraphWith(sectionSpan(readSpec(), "1.8"), LEAN_1_8), DELEGATION_LAYER),
			`§1.8 assigns challenger axes "${LEAN_1_8}" — an actor no section defines. Point the dispatcher at ` +
				`§${DELEGATION_LAYER} (issue #81 signal-3 criterion), norm content untouched.`,
		);
	});

	it("§4.8 carries the reciprocal §4.9 pointer", () => {
		assert.ok(
			carriesPointer(bodyParagraphs(sectionSpan(readSpec(), "4.8")).join("\n"), DELEGATION_LAYER),
			`§4.8 does not point at §${DELEGATION_LAYER}, so the boundary between a command asset and a dispatch ` +
				"instrument is drawn from one side only — a reader inside §4.8 cannot discover that the instrument " +
				"sits outside its rule range. Add the reciprocal pointer (issue #81 signal-2 criterion).",
		);
	});

	it("§4.9 records a measured substrate version and the content-free-return sentence", () => {
		const span = sectionSpan(readSpec(), DELEGATION_LAYER);
		assert.ok(
			substrateVersionTokens(span).length > 0,
			`§${DELEGATION_LAYER} states no substrate version it measured the homing rule's surfaces against, so a ` +
				"reader cannot tell whether the recorded surfaces were ever measured or against what — issue #81's " +
				'signal-1 criterion calls that record "this criterion\'s checkable residue" (§2.4). Record the ' +
				"measurement as `pi <major>.<minor>.<patch>`. This arm pins that a version is RECORDED; it never " +
				"pins that it is current (equality against the installed `pi --version` would false-red on a newer " +
				"clone — §3.12).",
		);
		assert.notEqual(
			contentFreeReturnParagraph(span),
			"",
			`§${DELEGATION_LAYER} carries no paragraph stating the content-free-return sentence — that the bounded ` +
				"structured return stays content-free and never supplies the compare operand of §1.6's blind " +
				"compare. State it in one paragraph. This arm pins that the sentence EXISTS, never that any " +
				"instrument honors it.",
		);
	});

	it("§4's intro paragraph enumerates §4.9", () => {
		assert.ok(
			carriesPointer(bodyParagraphs(sectionSpan(readSpec(), "4")).join("\n"), DELEGATION_LAYER),
			`§4's intro enumerates its subsections and omits §${DELEGATION_LAYER}; a section absent from its own ` +
				"parent's enumeration is reachable only by scrolling. Add it to the intro (issue #81 reach sweep).",
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
		"| &nbsp;&nbsp;§4.8 | The command layer | 545 |",
		"| &nbsp;&nbsp;§4.9 | The delegation layer | 600 |",
		"<!-- TOC END -->",
		"",
		"## 1. Work norms",
		"",
		"### 1.5 Delegated work",
		"",
		"A paragraph the arm does not bind, naming no deferral.",
		"",
		"The norm is advisory; the delegate roles are instruments that derive later (§4.9).",
		"",
		"## 4. Substrate and install contract",
		"",
		"This intro enumerates §4.8 and §4.9.",
		"",
		"### 4.8 The command layer",
		"",
		"A dispatch instrument is not a command asset and sits outside this rule range (§4.9).",
		"",
		"### 4.90 A decoy whose number merely starts with 4.9",
		"",
		"Nothing here belongs to §4.9.",
		"",
		"### 4.9 The delegation layer",
		"",
		"Measured against pi 0.84.3 on this date.",
		"",
		"The structured return is content-free: it never supplies the compare operand.",
		"",
		"## 5. Cross-cutting contracts",
		"",
		"Past the end of §4.9's span.",
	].join("\n");

	it("finds a §4.9 TOC row that is there", () => {
		assert.deepEqual(tocRowsFor(tocBlock(SYNTHETIC), "4.9"), [
			"| &nbsp;&nbsp;§4.9 | The delegation layer | 600 |",
		]);
	});

	it("finds no §4.9 TOC row on a contents that lacks one", () => {
		const withoutRow = SYNTHETIC.replace("| &nbsp;&nbsp;§4.9 | The delegation layer | 600 |\n", "");
		assert.deepEqual(tocRowsFor(tocBlock(withoutRow), "4.9"), []);
	});

	it("does not count a row that only MENTIONS §4.9 in its title cell", () => {
		assert.deepEqual(tocRowsFor("| &nbsp;&nbsp;§4.8 | The command layer, see §4.9 | 545 |", "4.9"), []);
	});

	it("does not count a prefix-sharing row as §4.9's own", () => {
		assert.deepEqual(tocRowsFor("| &nbsp;&nbsp;§4.91 | Not this one | 900 |", "4.9"), []);
	});

	it("returns no TOC block when the markers are absent — an unparseable contents is not an empty pass", () => {
		assert.deepEqual(tocRowsFor(tocBlock("| &nbsp;&nbsp;§4.9 | The delegation layer | 600 |"), "4.9"), []);
	});

	it("returns no TOC block when the markers are out of order", () => {
		assert.equal(tocBlock(`${TOC_END}\n| &nbsp;&nbsp;§4.9 | x | 1 |\n${TOC_START} -->`), "");
	});

	it("spans a subsection from its heading to the next heading", () => {
		const span = sectionSpan(SYNTHETIC, "4.8");
		assert.ok(span.includes("outside this rule range") && !span.includes("decoy"));
	});

	it("spans a top-level section's INTRO only, excluding its subsections", () => {
		const span = sectionSpan(SYNTHETIC, "4");
		assert.ok(span.includes("This intro enumerates") && !span.includes("### 4.8"));
	});

	it("stops a span at the next top-level heading", () => {
		assert.ok(!sectionSpan(SYNTHETIC, "4.9").includes("Past the end"));
	});

	it("does not mistake §4.90's heading for §4.9's", () => {
		assert.ok(!sectionSpan(SYNTHETIC, "4.9").includes("A decoy"));
	});

	it("returns an empty span for a section that is absent — the pre-change shape every §4.9 arm reds on", () => {
		const withoutSection = SYNTHETIC.replace("### 4.9 The delegation layer", "### 4.11 Something else");
		assert.equal(sectionSpan(withoutSection, "4.9"), "");
	});

	it("selects the paragraph carrying the needle, not the whole span", () => {
		assert.ok(paragraphWith(sectionSpan(SYNTHETIC, "1.5"), LEAN_1_5).includes("§4.9"));
	});

	it("selects no paragraph when none carries the needle", () => {
		assert.equal(paragraphWith(sectionSpan(SYNTHETIC, "1.5"), LEAN_1_7), "");
	});

	it("drops heading lines from a span's body paragraphs", () => {
		assert.deepEqual(bodyParagraphs(sectionSpan(SYNTHETIC, "4.9")), [
			"Measured against pi 0.84.3 on this date.",
			"The structured return is content-free: it never supplies the compare operand.",
		]);
	});

	it("reports a §4.9 pointer, including a sentence-final one", () => {
		assert.ok(carriesPointer("a call site beneath §3.3 (§4.9)", "4.9") && carriesPointer("see §4.9.", "4.9"));
	});

	it("stays silent on a neighbouring section's pointer", () => {
		assert.equal(carriesPointer("§4.8 states the command layer, and §4.7 the host boundary", "4.9"), false);
	});

	it("stays silent on a section number that merely extends §4.9", () => {
		assert.equal(carriesPointer("§4.91 and §4.9.1 are other sections", "4.9"), false);
	});

	it("stays silent on a §4.9 pointer that sits in a paragraph the arm does not bind", () => {
		assert.equal(
			carriesPointer(paragraphWith(sectionSpan(SYNTHETIC, "1.5"), "names no deferral"), "4.9"),
			false,
		);
	});

	it("reports a substrate version recorded beside the substrate's name", () => {
		assert.deepEqual(substrateVersionTokens("the surfaces were measured against pi 0.84.3 on 2026-09-05"), [
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

	it("finds the content-free-return paragraph that is there", () => {
		assert.equal(
			contentFreeReturnParagraph(sectionSpan(SYNTHETIC, "4.9")),
			"The structured return is content-free: it never supplies the compare operand.",
		);
	});

	it("tolerates wording inflection — spaced hyphen, `comparison`, plural operands", () => {
		assert.notEqual(
			contentFreeReturnParagraph("### 4.9 x\n\nThe return stays content free and carries no comparison operands."),
			"",
		);
	});

	it("finds no content-free-return paragraph when the compare-operand token is absent", () => {
		assert.equal(contentFreeReturnParagraph("### 4.9 x\n\nThe structured return is content-free."), "");
	});

	it("finds no content-free-return paragraph when the content-free token is absent", () => {
		assert.equal(contentFreeReturnParagraph("### 4.9 x\n\nThe return never supplies the compare operand."), "");
	});

	it("finds no content-free-return paragraph when the tokens sit in different paragraphs", () => {
		assert.equal(
			contentFreeReturnParagraph("### 4.9 x\n\nThe return is content-free.\n\nIt never supplies the compare operand."),
			"",
		);
	});
});
