/**
 * Hermetic integration suite for the egress publish instrument (issue #83
 * AC1, AC2, AC3, AC6; SPEC §3.3 "egress publish-boundary semantics").
 *
 * Drives real `pi` sessions through `harness/run-pi.ts` with the gitjig
 * runtime linked from this repository's tree and a PATH-prepended `gh`
 * SHIM — a fixture-local script that tees argv, cwd, and stdin into sink
 * files and prints a well-formed comment URL. Every instrument arm is RED
 * until the Code phase registers the `gitjig_publish` tool: the scripted
 * toolCall reaches no handler today, the substrate answers "Tool
 * gitjig_publish not found", and each arm's first assertion is authored to
 * fail on exactly that absence.
 *
 * AUTHORED PHASE-C CONTRACT (what these arms bind to):
 *   - tool name `gitjig_publish` (SPEC §3.3's egress row, verbatim);
 *   - arguments `{ body: string, destination: { kind: "issue-comment",
 *     number: number } }` — the body composed into the call, the
 *     destination structured (§3.3's measurement-domain clause);
 *   - the destination union's spelling for issue-comment is the child argv
 *     `gh issue comment <number> --body-file -` with the body on stdin;
 *   - refusal evidence lands on the audit surface as records with
 *     `"category":"egress"`, naming pattern IDs on a match and no pattern
 *     ID on the out-of-domain arm, never the matched text (§3.8, §5.5);
 *   - neutralization transforms each relayed shape whole (`@user`,
 *     close-keyword pairs in both separator spellings, GH-N, URL-form,
 *     cross-repo refs) into a space-padded backtick wrap whose delimiter
 *     run is one longer than the longest run in the text each pass lands
 *     in — CommonMark pairs equal-length runs, so a fixed one-backtick
 *     wrap is defeated by a stray or adjacent body backtick — while the
 *     bare same-repo `#N` stays live (§3.3's recorded decision).
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. The shim proves argv/stdin/cwd
 * discipline against the shim's own contract, never real `gh` behavior:
 * the comment-URL success key is the shim's promise, and what a real `gh`
 * mismatch produces is the executor suite's `outcome-unverified` ground,
 * not this suite's. Byte-absence claims are scoped to the surfaces read
 * here — toolResult session entries, the audit trail, the shim sink. The
 * assistant message that CARRIES the toolCall persists the refused body as
 * the call's own arguments; that surface is §3.3's enumerated residual
 * (measured in the Doc phase) and is deliberately EXCLUDED from every
 * leak-domain assertion below. Adversarially encoded payloads are out of
 * scope by the same §3.3 residual: this is in-session mistake prevention.
 *
 * Mutants, both directions: the refusal arms (matching body → withheld)
 * and the false-block arm (near-miss body → published) drive the boundary
 * from both sides, so an always-refuse or always-publish instrument
 * reddens either way; neutralization pins wrapped shapes AND the live bare
 * reference, so an over-wrapping implementation reddens too. Control bytes
 * ride generator escapes only (case-set header note).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	type PiRunResult,
	readAuditLines,
	readSessionEntries,
	removeFixture,
	runPi,
} from "./harness/run-pi.ts";
import {
	AWS_JOINED,
	BODY_MEASUREMENT_CASES,
	committedPatternRows,
	CONFORMANCE_CASES,
} from "./harness/secret-pattern-cases.ts";

const TOOL = "gitjig_publish";
const SUBSTRATE_NOT_FOUND = /Tool gitjig_publish not found/;
/** The shim's promised success output — a well-formed comment URL. */
const SHIM_URL = "https://github.com/zqowner/zqrepo/issues/5#issuecomment-987654321";

/** One authored red message shape for every subject-absence anchor. */
function redUntilRegistered(arm: string): string {
	return (
		`${arm}: red until the Code phase registers the ${TOOL} tool (issue #83; SPEC §3.3's egress ` +
		`home slot) — the scripted toolCall reached no handler and the substrate answered for the missing tool`
	);
}

const awsCase = CONFORMANCE_CASES.find((c) => c.id === "aws-access-key-id");
const githubCase = CONFORMANCE_CASES.find((c) => c.id === "github-token");
assert.ok(awsCase !== undefined && githubCase !== undefined, "the case set lost a committed ID this suite builds bodies from");

const SECRET_BODY = "zqrefusal context line\n" + (awsCase as { match: string }).match + "\nzqrefusal trailing line\n";

/**
 * Each shape with its expected delimiter run length. The wrap delimiter is
 * recomputed per pass (longest backtick run in the current text + 1), and
 * the passes run URL → close-pair → cross-repo → GH-N → mention: on a
 * backtick-free body where every pass matches, the delimiters escalate
 * 1, 2, 3, 4, 5 in that pass order.
 */
const NEUTRAL_SHAPES: ReadonlyArray<{ raw: string; delimiter: number }> = [
	{ raw: "https://github.com/zqowner/zqrepo/issues/11", delimiter: 1 },
	{ raw: "Fixes #7", delimiter: 2 },
	{ raw: "zqowner/zqrepo#13", delimiter: 3 },
	{ raw: "GH-9", delimiter: 4 },
	{ raw: "@zquser", delimiter: 5 },
];
const NEUTRAL_BODY =
	"zqneutral opening line\n" +
	"ping @zquser about this\n" +
	"the relay quotes Fixes #7 verbatim\n" +
	"tracked as GH-9 upstream\n" +
	"thread at https://github.com/zqowner/zqrepo/issues/11 today\n" +
	"twin issue zqowner/zqrepo#13 stays open\n" +
	"see #3 for context\n";

/**
 * The two measured defeat constructions for a fixed one-backtick wrap —
 * a stray body backtick that flips CommonMark's equal-length pairing
 * (line 1) and a body backtick adjacent to the wrap that merges runs so
 * no span forms (line 2) — plus both colon-trailer close-pair spellings
 * and the deliberate separator-free non-match (§3.3).
 */
const HOSTILE_BODY =
	"a stray ` backtick precedes @zqstray in this relay\n" +
	"quoting `@zqadjacent right against the wrap\n" +
	"trailer spellings Fixes: #21 and fixes:#22 arrive live\n" +
	"bare fixes#23 adjacency stays a deliberate non-match\n";

const FALSE_BLOCK_BODY =
	"reviewing the redaction helper:\n" +
	'const looksLikeKey = (s) => s.startsWith("' +
	(awsCase as { nearMiss: string }).nearMiss +
	'");\n' +
	'const tokenTail = "' +
	(githubCase as { nearMiss: string }).nearMiss +
	'";\n' +
	"this quote handles key-shaped strings and must publish\n";

const nulCase = BODY_MEASUREMENT_CASES.find((c) => c.name === "nul-binary");
const cfCase = BODY_MEASUREMENT_CASES.find((c) => c.name === "cf-split");
assert.ok(nulCase !== undefined && cfCase !== undefined, "the case set lost a body-measurement case this suite rides");

// ---------------------------------------------------------------------------
// Substrate: fixture + gh shim + one publish call.
// ---------------------------------------------------------------------------

interface PublishRun {
	fixture: Fixture;
	result: PiRunResult;
	sinkDir: string;
}

/**
 * The well-behaved shim: tee argv, cwd, and stdin into the sink, then
 * print the promised comment URL on stdout and exit 0. Sink paths carry no
 * quote (mkdtemp shapes), so the single-quoted interpolation is exact.
 */
async function runPublish(body: string): Promise<PublishRun> {
	const fixture = buildFixture({
		script: [
			{ kind: "toolCall", name: TOOL, arguments: { body, destination: { kind: "issue-comment", number: 5 } } },
			{ kind: "text", text: "EGRESS_IT_DONE" },
		],
		linkGitjigRuntime: true,
	});
	const binDir = join(fixture.root, "bin");
	const sinkDir = join(fixture.root, "sink");
	mkdirSync(binDir);
	mkdirSync(sinkDir);
	const shimPath = join(binDir, "gh");
	writeFileSync(
		shimPath,
		`#!/bin/sh\nSINK='${sinkDir}'\n` +
			`printf '%s\\n' "$@" >> "$SINK/gh-argv"\n` +
			`pwd >> "$SINK/gh-cwd"\n` +
			`cat >> "$SINK/gh-stdin"\n` +
			`printf '%s\\n' '${SHIM_URL}'\n`,
	);
	chmodSync(shimPath, 0o755);
	const result = await runPi(fixture, {
		env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
		timeoutMs: 90_000,
	});
	return { fixture, result, sinkDir };
}

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

interface ToolResultMessage {
	role: string;
	toolName?: string;
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
}

/** Every toolResult session entry for the publish tool — the RESULT surface (header note). */
function publishResults(fixture: Fixture): ToolResultMessage[] {
	return readSessionEntries(fixture)
		.map((entry) => (entry as { type?: string; message?: ToolResultMessage }).message)
		.filter(
			(message): message is ToolResultMessage =>
				message !== undefined && message.role === "toolResult" && message.toolName === TOOL,
		);
}

function textOf(message: ToolResultMessage): string {
	return (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

/** The subject-absence anchor: the tool's OWN result, not the substrate's stand-in. */
function requireOwnResult(run: PublishRun, arm: string): ToolResultMessage {
	const results = publishResults(run.fixture);
	assert.equal(results.length, 1, `${arm}: expected exactly one ${TOOL} toolResult\n${diagnostics(run.result)}`);
	const own = results[0];
	assert.ok(!SUBSTRATE_NOT_FOUND.test(textOf(own)), redUntilRegistered(arm));
	return own;
}

function auditLines(run: PublishRun): string[] {
	return existsSync(run.fixture.auditFile) ? readAuditLines(run.fixture) : [];
}

/** Audit records the instrument owes: the egress category (authored contract). */
function egressAuditLines(run: PublishRun): string[] {
	return auditLines(run).filter((line) => line.includes('"category":"egress"'));
}

/** Every byte the shim sink captured, concatenated (absent files = nothing). */
function sinkBytes(run: PublishRun): Buffer {
	if (!existsSync(run.sinkDir)) {
		return Buffer.alloc(0);
	}
	const parts = readdirSync(run.sinkDir)
		.sort()
		.map((name) => readFileSync(join(run.sinkDir, name)));
	return Buffer.concat(parts);
}

/**
 * The egress leak domain (§3.8): guarded bytes reach neither the tool's
 * result entries, nor the audit trail, nor the shim sink. The assistant
 * toolCall-args entry is EXCLUDED — §3.3's enumerated residual (header).
 */
function assertOffEgressSurfaces(run: PublishRun, guarded: string, what: string, arm: string): void {
	for (const message of publishResults(run.fixture)) {
		assert.ok(
			!JSON.stringify(message).includes(guarded),
			`${arm}: ${what} reached a toolResult entry — a result a composer may relay must stay content-free (§3.3, §4.9)`,
		);
	}
	for (const line of auditLines(run)) {
		assert.ok(!line.includes(guarded), `${arm}: ${what} reached the audit trail (§3.8's refusal-record rule)`);
	}
	assert.ok(
		!sinkBytes(run).includes(Buffer.from(guarded, "utf8")),
		`${arm}: ${what} reached the shim sink — bytes the gate refused left the process anyway (§3.3 withholding)`,
	);
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * Whole-shape wrap at the expected delimiter run length, space-padded:
 * every occurrence of the raw shape is a wrapped one.
 */
function assertNeutralized(capture: string, raw: string, delimiter: number, arm: string): void {
	const run = "`".repeat(delimiter);
	const wrapped = run + " " + raw + " " + run;
	assert.ok(
		occurrences(capture, wrapped) >= 1,
		`${arm}: relayed shape ${JSON.stringify(raw)} was not published in its delimiter-aware inert spelling ` +
			`${JSON.stringify(wrapped)} (§3.3 neutralization)`,
	);
	assert.equal(
		occurrences(capture, raw),
		occurrences(capture, wrapped),
		`${arm}: a live spelling of ${JSON.stringify(raw)} survived outside backticks — it can still page or auto-close (§3.7(e), §3.11)`,
	);
}

// ---------------------------------------------------------------------------
// Runs — one fixture per body, sequential.
// ---------------------------------------------------------------------------

let secretRun: PublishRun;
let neutralRun: PublishRun;
let hostileRun: PublishRun;
let falseBlockRun: PublishRun;
let nulRun: PublishRun;
let cfRun: PublishRun;

before(async () => {
	secretRun = await runPublish(SECRET_BODY);
	neutralRun = await runPublish(NEUTRAL_BODY);
	hostileRun = await runPublish(HOSTILE_BODY);
	falseBlockRun = await runPublish(FALSE_BLOCK_BODY);
	nulRun = await runPublish((nulCase as { body: string }).body);
	cfRun = await runPublish((cfCase as { body: string }).body);
});

after(() => {
	for (const run of [secretRun, neutralRun, hostileRun, falseBlockRun, nulRun, cfRun]) {
		if (run !== undefined) {
			removeFixture(run.fixture);
		}
	}
});

// ---------------------------------------------------------------------------
// AC1 — refusal and withholding.
// ---------------------------------------------------------------------------

describe("AC1: a secret-shaped body is refused, content-free (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(secretRun, "refusal");
	});

	it("the refusal's audit record names the egress class and the pattern ID", () => {
		const naming = egressAuditLines(secretRun).filter((line) => line.includes("aws-access-key-id"));
		assert.ok(
			naming.length >= 1,
			`refusal: no egress audit record names 'aws-access-key-id' — ` +
				redUntilRegistered("refusal record") +
				`; audit: ${JSON.stringify(auditLines(secretRun))}`,
		);
	});

	it("the matched text reaches no result entry, no audit record, and no shim sink", () => {
		// Both refusal preconditions repeat on purpose (sibling-suite idiom):
		// with the instrument absent every surface is empty and a bare
		// absence sweep would green vacuously.
		assert.ok(
			egressAuditLines(secretRun).length >= 1,
			"refusal leak-domain: no egress audit record to anchor the absence sweep — " + redUntilRegistered("refusal"),
		);
		assertOffEgressSurfaces(secretRun, (awsCase as { match: string }).match, "the secret span's bytes", "refusal");
	});

	it("withholding: the shim sink stays empty after the refusal", () => {
		assert.ok(
			egressAuditLines(secretRun).length >= 1,
			"withholding: no egress audit record to anchor the empty-sink claim — " + redUntilRegistered("withholding"),
		);
		assert.equal(
			sinkBytes(secretRun).length,
			0,
			"withholding: the shim captured bytes after a refusal — the refused publish reached the child anyway (§3.3)",
		);
	});
});

// ---------------------------------------------------------------------------
// AC2 — neutralization on the emitted bytes.
// ---------------------------------------------------------------------------

describe("AC2: relayed shapes publish in inert spellings (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(neutralRun, "neutralization");
	});

	it("every relayed shape reaches the shim's stdin backtick-wrapped, whole-shape", () => {
		const stdinPath = join(neutralRun.sinkDir, "gh-stdin");
		assert.ok(existsSync(stdinPath), redUntilRegistered("neutralization stdin capture"));
		const capture = readFileSync(stdinPath, "utf8");
		for (const shape of NEUTRAL_SHAPES) {
			assertNeutralized(capture, shape.raw, shape.delimiter, "neutralization");
		}
	});

	it("the bare same-repository #N stays live (§3.3's recorded decision)", () => {
		const stdinPath = join(neutralRun.sinkDir, "gh-stdin");
		assert.ok(existsSync(stdinPath), redUntilRegistered("bare-reference capture"));
		const capture = readFileSync(stdinPath, "utf8");
		assert.ok(
			capture.includes("see #3 for context"),
			"bare reference: the same-repo pointer idiom did not survive publication intact",
		);
		// Any wrap shape puts a backtick run (with or without its space
		// padding) directly against the reference; the live idiom never does.
		assert.doesNotMatch(
			capture,
			/`+ ?#3\b/,
			"bare reference: the same-repo #N was neutralized — §3.3 records it live; wrapping it breaks §5.1's pointer idiom",
		);
	});
});

// ---------------------------------------------------------------------------
// AC2 — the wrap under hostile/incidental backticks, and the colon trailer.
// ---------------------------------------------------------------------------

describe("AC2: the wrap survives body backticks; colon trailers are claimed (issue #83)", () => {
	function hostileCapture(): string {
		const stdinPath = join(hostileRun.sinkDir, "gh-stdin");
		assert.ok(existsSync(stdinPath), redUntilRegistered("hostile-body capture"));
		return readFileSync(stdinPath, "utf8");
	}

	it("a stray body backtick cannot flip the pairing: the delimiter run out-runs it", () => {
		// Regression construction 1: with a fixed one-backtick wrap, the stray
		// backtick pairs with the wrap's opener and the mention renders live.
		// Here the passes that fired are close-pair (delimiter 2, longest run
		// in the body is 1) then mention (delimiter 3).
		const capture = hostileCapture();
		assert.ok(
			capture.includes("``` @zqstray ```"),
			"stray backtick: the mention did not publish at the delimiter length that out-runs the stray run (§3.3)",
		);
		assert.equal(
			occurrences(capture, "@zqstray"),
			1,
			"stray backtick: a live spelling of the mention survived outside its wrap",
		);
	});

	it("a body backtick adjacent to the wrap is separated, so the runs never merge", () => {
		// Regression construction 2: a delimiter touching the body backtick
		// merges into one longer run and no span forms at all.
		const capture = hostileCapture();
		assert.ok(
			capture.includes("quoting ` ``` @zqadjacent ```"),
			"adjacent backtick: no separating space between the body backtick and the wrap delimiter — " +
				"the merged run forms no span and the mention renders live (§3.3)",
		);
		assert.equal(
			occurrences(capture, "@zqadjacent"),
			1,
			"adjacent backtick: a live spelling of the mention survived outside its wrap",
		);
	});

	it("both colon-trailer spellings are claimed; separator-free adjacency stays a non-match", () => {
		// Platform assumption, RECORDED and not verified here: GitHub honors
		// the colon trailer (`Fixes: #N` drives auto-close like `Fixes #N`).
		const capture = hostileCapture();
		assert.ok(
			capture.includes("`` Fixes: #21 ``"),
			"colon trailer: `Fixes: #N` published live — the colon spelling drives the auto-close channel (§3.3)",
		);
		assert.ok(
			capture.includes("`` fixes:#22 ``"),
			"colon trailer: `fixes:#N` published live — the whitespace-free colon spelling drives auto-close (§3.3)",
		);
		assert.ok(
			capture.includes("bare fixes#23 adjacency stays a deliberate non-match"),
			"non-match: separator-free `fixes#N` was rewritten — §3.3 keeps that adjacency a deliberate non-match",
		);
	});
});

// ---------------------------------------------------------------------------
// AC3 — false-block recovery: key-shaped quotes still publish.
// ---------------------------------------------------------------------------

describe("AC3: a key-shaped quote matching no committed pattern publishes (issue #83)", () => {
	it("the publish tool answers for itself, and not with an error", () => {
		const own = requireOwnResult(falseBlockRun, "false-block");
		assert.ok(
			own.isError !== true,
			`false-block: a body matching no committed pattern was refused — the named false-block cost's ` +
				`recovery arm must ship with the scan (§3.6): ${textOf(own)}`,
		);
	});

	it("the quoted near-miss lines reach the shim intact", () => {
		const stdinPath = join(falseBlockRun.sinkDir, "gh-stdin");
		assert.ok(existsSync(stdinPath), redUntilRegistered("false-block publication"));
		const capture = readFileSync(stdinPath, "utf8");
		assert.ok(
			capture.includes((awsCase as { nearMiss: string }).nearMiss) &&
				capture.includes((githubCase as { nearMiss: string }).nearMiss),
			"false-block: the published body lost its key-shaped quotes — over-redaction is its own defect (§3.6's named cost)",
		);
	});
});

// ---------------------------------------------------------------------------
// AC6 — destination handling: the structured union's argv spelling.
// ---------------------------------------------------------------------------

describe("AC6: the issue-comment destination becomes the pinned gh argv (issue #83)", () => {
	it("the shim receives `issue comment 5 --body-file -` and the body on stdin", () => {
		const argvPath = join(falseBlockRun.sinkDir, "gh-argv");
		assert.ok(existsSync(argvPath), redUntilRegistered("destination argv capture"));
		const argv = readFileSync(argvPath, "utf8").split("\n").filter((line) => line !== "");
		assert.deepEqual(
			argv,
			["issue", "comment", "5", "--body-file", "-"],
			"destination: the argv drifted from the issue-comment union's pinned spelling — the body must ride " +
				"stdin (--body-file -), never an argv byte (§3.3's exact-bytes domain)",
		);
	});
});

// ---------------------------------------------------------------------------
// Out-of-domain and Cf-split refusals through the full instrument.
// ---------------------------------------------------------------------------

describe("AC1: a NUL-bearing body refuses out-of-domain, with no pattern ID (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(nulRun, "out-of-domain");
	});

	it("the refusal is the out-of-domain category: an egress record naming NO committed pattern", () => {
		const lines = egressAuditLines(nulRun);
		assert.ok(lines.length >= 1, redUntilRegistered("out-of-domain record"));
		for (const line of lines) {
			for (const row of committedPatternRows()) {
				assert.ok(
					!line.includes(row.id),
					`out-of-domain: the record names pattern '${row.id}' — an unmeasurable body is not a pattern match (§3.9's split)`,
				);
			}
		}
	});

	it("nothing reaches the shim sink", () => {
		assert.ok(egressAuditLines(nulRun).length >= 1, redUntilRegistered("out-of-domain withholding"));
		assert.equal(sinkBytes(nulRun).length, 0, "out-of-domain: the refused body reached the publish child (§3.3)");
	});
});

describe("AC1: a Cf-split secret is refused naming the pattern (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(cfRun, "cf-split");
	});

	it("the Cf strip closes the split: the record names aws-access-key-id", () => {
		const naming = egressAuditLines(cfRun).filter((line) => line.includes("aws-access-key-id"));
		assert.ok(
			naming.length >= 1,
			"cf-split: no egress record names the pattern — the format-character strip is §3.3 step 2's " +
				"over-match closure and the divergence from tier-2's recorded residual; " +
				redUntilRegistered("cf-split refusal"),
		);
	});

	it("neither the split nor the joined spelling reaches any egress surface", () => {
		assert.ok(egressAuditLines(cfRun).length >= 1, redUntilRegistered("cf-split leak domain"));
		assertOffEgressSurfaces(cfRun, (cfCase as { body: string }).body.trim(), "the Cf-split span's raw bytes", "cf-split");
		assertOffEgressSurfaces(cfRun, AWS_JOINED, "the joined (stripped) spelling", "cf-split");
	});
});
