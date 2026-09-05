/**
 * Hermetic pi integration suite for the dispatch instrument's registered
 * tool (issue #88; SPEC §4.9 — one home, many call sites; the measured
 * ground: a registered tool's result enters the run's session file).
 *
 * Drives one real `pi` session through `harness/run-pi.ts` whose scripted
 * provider issues a `gitjig_dispatch` toolCall. Every instrument arm is
 * RED until the Code phase registers the tool: the toolCall reaches no
 * handler today, the substrate answers "Tool gitjig_dispatch not found",
 * and each arm's first assertion is authored to fail on exactly that
 * absence (the sibling egress suites' anchor, verbatim in shape).
 *
 * FIXTURE SHAPE (the harness is read-only; the repo mints inline). The
 * gitjig runtime enters the fixture as COPIED bytes, not the sibling
 * suites' symlinks: the runtime resolves its repository root from its own
 * REALPATH (`locate.ts`, §4.6), so a symlinked install resolves to this
 * repository — and this suite needs the dispatcher's caller repo to be the
 * fixture itself. The copies are read from this repository's tree at
 * build time, so the committed bytes are still what runs. The fixture
 * root is then `git init`ed and a PATH-SCOPED add commits exactly the
 * delegate-visible assets — `.pi/` (scripted provider + gitjig runtime),
 * the delegate script, the child's script file, one content file — and
 * deliberately NOT the parent's `script.json`: the clone must not carry
 * the parent's turns, or the child session would replay the dispatch
 * toolCall recursively. Commits ride
 * `-c user.name=zq -c user.email=zq@zq.zq -c commit.gpgsign=false`
 * (mandatory: the host signs commits and the throwaway identity cannot).
 *
 * THE ROUND TRIP (modeled on the Doc commit's measured delegate shape:
 * a no-hardlinks clone carrying committed `.pi/` runs a headless child
 * session on the scripted provider). The dispatched delegate is
 * `sh zq-delegate.sh` in the cloned tree: it stages the CHILD's script,
 * runs a child `pi -p` session there (the clone's committed provider and
 * runtime load; the child's state seam is the executor-provided
 * `<scratch>/state`), keys on the child's `DELEGATE_DONE marker-alpha`
 * output, computes `git rev-parse HEAD` in the clone, and writes the
 * bounded return to `../return.json` — fixed printf formats, so the
 * return is well-formed JSON whatever the child printed.
 *
 * AUTHORED PHASE-C CONTRACT (beyond the module suite's): the tool is
 * named `gitjig_dispatch`; its arguments are `{ brief: string,
 * delegateArgv: string[], expectedRef?: string }` (`expectedRef` a ref
 * NAME, resolved once in the caller repository); the result carries the
 * admitted return's summary and, when a `reviewedHead` was consumed, the
 * compare verdict token (`confirmed`/`invalid`) — validity alone, never
 * an operand; the dispatch act lands at least one `"category":"dispatch"`
 * audit record through the landed writer; the executor passes the parent
 * environment through (the child `pi` needs the parent's PATH/HOME/
 * PI_OFFLINE isolation) with the repo-locating `GIT_*` family removed
 * and the state seam rebound into the scratch.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. The round trip proves the
 * DISPATCHER's provision → child-session → bounded-return path, never any
 * delegate's quality: the child is a scripted echo, and a green run says
 * nothing about what a real delegate would do with the brief. The
 * operand-absence sweep is LEXICAL — case-folded ≥ 4-char hex runs held
 * to containment against the held operand, the implementation's own
 * rule — on the surfaces read here: the tool's result entries, the audit
 * trail, and the session transcript with the assistant
 * toolCall-arguments field excluded BY NAME (the sibling suites'
 * measured residual: the assistant message persists the call's own
 * arguments; nothing this suite sends carries the hash there, and the
 * exclusion keeps the sweep honest about that surface rather than
 * crediting it) — a paraphrased or re-encoded operand is §4.9's
 * injectable-context residual, not this sweep's catch. The scratch (child sessions included) is cleaned on
 * success, so no arm reads it. One run, one direction per surface: the
 * compare-invalid and refusal directions are the module suite's arms.
 *
 * The sweep helpers' own teeth are pinned in-suite against synthetic
 * strings, both directions (§3.12) — those arms are green on this tree;
 * every instrument arm is red.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	type PiRunResult,
	readAuditLines,
	readSessionEntries,
	removeFixture,
	repoRoot,
	runPi,
} from "./harness/run-pi.ts";

const TOOL = "gitjig_dispatch";
const SUBSTRATE_NOT_FOUND = /Tool gitjig_dispatch not found/;
const CHILD_MARKER = "DELEGATE_DONE marker-alpha";
const SUMMARY = `the child session relayed ${CHILD_MARKER}`;

function redUntilRegistered(arm: string): string {
	return (
		`${arm}: red until the Code phase registers the ${TOOL} tool (issue #88; SPEC §4.9's home at ` +
		`.pi/extensions/gitjig/dispatch/) — the scripted toolCall reached no handler and the substrate ` +
		`answered for the missing tool`
	);
}

// ---------------------------------------------------------------------------
// Fixture: copied runtime + inline-minted caller repo + one dispatch call.
// ---------------------------------------------------------------------------

/**
 * The committed runtime as bytes, walked from this repository's tree at
 * build time — `gitjig.ts` plus everything under `gitjig/`, the dispatch
 * modules included once they land.
 */
function runtimeFileMap(): Record<string, string> {
	const base = join(repoRoot(), ".pi", "extensions");
	const map: Record<string, string> = { "gitjig.ts": readFileSync(join(base, "gitjig.ts"), "utf8") };
	const walk = (rel: string): void => {
		for (const item of readdirSync(join(base, rel), { withFileTypes: true })) {
			const childRel = `${rel}/${item.name}`;
			if (item.isDirectory()) {
				walk(childRel);
			} else {
				map[childRel] = readFileSync(join(base, rel, item.name), "utf8");
			}
		}
	};
	walk("gitjig");
	return map;
}

/** The child session's whole script: one text turn carrying the marker. */
const CHILD_SCRIPT = `${JSON.stringify([{ kind: "text", text: CHILD_MARKER }], null, "\t")}\n`;

/**
 * The delegate, committed into the caller repo and run by the dispatcher
 * as `sh zq-delegate.sh` with cwd = the cloned tree. Fixed printf formats
 * keep the return well-formed whatever the child prints; the `case` keys
 * the delegate's ok on the child's marker (§3.10's output-validity idiom,
 * delegate-side).
 */
const DELEGATE_SCRIPT = [
	"#!/bin/sh",
	"cp zq-child-script.json script.json",
	'head=$(git rev-parse HEAD)',
	"out=$(pi -p 'run the delegate script' -a --session-dir zq-child-sessions --provider scripted " +
		"--model scripted-model < /dev/null 2> zq-child-stderr || printf '%s' PI_CHILD_FAILED)",
	'case "$out" in',
	`*"${CHILD_MARKER}"*) printf '{"ok":true,"summary":"${SUMMARY}","reviewedHead":"%s"}' "$head" > ../return.json ;;`,
	`*) printf '{"ok":false,"summary":"the child session missed its marker"}' > ../return.json ;;`,
	"esac",
	"",
].join("\n");

const SCRIPT = [
	{
		kind: "toolCall" as const,
		name: TOOL,
		arguments: {
			brief: "zq dispatch brief: run the committed delegate and return the marker",
			delegateArgv: ["sh", "zq-delegate.sh"],
			expectedRef: "main",
		},
	},
	{ kind: "text" as const, text: "DISPATCH_IT_DONE" },
];

const GIT_FLAGS = ["-c", "user.name=zq", "-c", "user.email=zq@zq.zq", "-c", "commit.gpgsign=false"];

let fixture: Fixture;
let result: PiRunResult;
/** The compare operand: the caller repo's HEAD, held at provision. */
let heldHash: string;

before(async () => {
	fixture = buildFixture({ script: SCRIPT, extensionFiles: runtimeFileMap() });
	writeFileSync(join(fixture.root, "zq-delegate.sh"), DELEGATE_SCRIPT);
	writeFileSync(join(fixture.root, "zq-child-script.json"), CHILD_SCRIPT);
	writeFileSync(join(fixture.root, "zq-base.txt"), "zq dispatch caller content\n");
	const git = (...args: string[]): string =>
		execFileSync("git", ["-C", fixture.root, ...GIT_FLAGS, ...args], { encoding: "utf8" });
	execFileSync("git", ["init", "-q", "-b", "main", fixture.root], { encoding: "utf8" });
	// Path-scoped on purpose: the parent's script.json, sessions/, state/,
	// home/, and pi-agent/ stay out of the history the dispatcher clones.
	git("add", ".pi", "zq-delegate.sh", "zq-child-script.json", "zq-base.txt");
	git("commit", "-q", "-m", "zq dispatch caller fixture");
	heldHash = git("rev-parse", "HEAD").trim();
	result = await runPi(fixture, { timeoutMs: 180_000 });
});

after(() => {
	if (fixture !== undefined) {
		removeFixture(fixture);
	}
});

function diagnostics(): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

interface ToolResultMessage {
	role: string;
	toolName?: string;
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
}

function dispatchResults(): ToolResultMessage[] {
	return readSessionEntries(fixture)
		.map((entry) => (entry as { message?: ToolResultMessage }).message)
		.filter(
			(message): message is ToolResultMessage =>
				message !== undefined && message.role === "toolResult" && message.toolName === TOOL,
		);
}

function textOf(message: ToolResultMessage): string {
	return (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

/** The subject-absence anchor: the tool's OWN result, not the stand-in. */
function requireOwnResult(arm: string): ToolResultMessage {
	const results = dispatchResults();
	assert.equal(results.length, 1, `${arm}: expected exactly one ${TOOL} toolResult\n${diagnostics()}`);
	const own = results[0];
	assert.ok(!SUBSTRATE_NOT_FOUND.test(textOf(own)), redUntilRegistered(arm));
	return own;
}

function auditLines(): string[] {
	return existsSync(fixture.auditFile) ? readAuditLines(fixture) : [];
}

function dispatchAuditLines(): string[] {
	return auditLines().filter((line) => line.includes('"category":"dispatch"'));
}

// ---------------------------------------------------------------------------
// The operand sweep (lexical; the implementation's own rule, mirrored).
// ---------------------------------------------------------------------------

/**
 * Every hex run of ≥ 4 chars in `text`, either case, that touches the
 * held operand — `namesHeldOperand`'s rule, mirrored: each run is
 * lowercased and flagged iff the held hash contains it (a slice crossed
 * the surface, prefix or interior) or it contains the held 7-prefix (the
 * operand embedded in a longer run). Anything else — session UUIDs,
 * unrelated hashes — is left alone: the sweep pins the operand, not hex
 * at large.
 */
function heldOperandRuns(text: string, held: string): string[] {
	const runs = text.match(/[0-9a-fA-F]{4,}/g) ?? [];
	const prefix = held.slice(0, 7);
	return runs.map((run) => run.toLowerCase()).filter((run) => held.includes(run) || run.includes(prefix));
}

/**
 * The transcript surface the sweep binds: every session entry, with the
 * assistant toolCall `arguments` field deleted BY NAME before
 * serialization — the enumerated residual surface (header), excluded
 * rather than silently credited.
 */
function transcriptSansCallArguments(entries: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const entry of entries) {
		const clone = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
		const message = clone.message as
			| { role?: string; content?: Array<Record<string, unknown>> }
			| undefined;
		if (message !== undefined && message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "toolCall") {
					delete part.arguments;
				}
			}
		}
		parts.push(JSON.stringify(clone));
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// The round trip.
// ---------------------------------------------------------------------------

describe("the dispatch round trip: clone, child session, bounded return (issue #88)", () => {
	it("the run completes and the dispatch tool answers for itself", () => {
		assert.equal(result.timedOut, false, `round-trip: the session wedged past its bound\n${diagnostics()}`);
		assert.equal(result.exitCode, 0, diagnostics());
		requireOwnResult("round-trip");
	});

	it("the bounded structured return crosses back: the result carries the delegate's summary, not an error", () => {
		const own = requireOwnResult("bounded-return");
		assert.ok(
			own.isError !== true,
			`bounded-return: the dispatch reported an error for a well-formed delegate run: ${textOf(own)}`,
		);
		assert.ok(
			textOf(own).includes(SUMMARY),
			`bounded-return: the admitted summary did not reach the tool's result — the bounded return is the ` +
				`one thing that crosses back (§1.5, §4.9); got: ${textOf(own)}\n${diagnostics()}`,
		);
	});

	it("the compare surfaces as validity alone: 'confirmed', no operand named", () => {
		const own = requireOwnResult("compare-surface");
		const text = textOf(own);
		assert.ok(
			text.includes("confirmed"),
			`compare-surface: the delegate reported the held head and the result does not say 'confirmed' — ` +
				`the caller consumes validity, never the pair (§1.6 via §4.9); got: ${text}`,
		);
		assert.deepEqual(
			heldOperandRuns(text, heldHash),
			[],
			"compare-surface: the result names the held operand — a compare outcome crosses back as validity " +
				"alone (§4.9's content-free return channels)",
		);
	});

	it("the dispatch act lands category-dispatch audit records through the landed writer", () => {
		requireOwnResult("audit-record");
		assert.ok(
			dispatchAuditLines().length >= 1,
			`audit-record: no "category":"dispatch" record on the audit trail — the dispatcher's acts ride the ` +
				`landed writer (issue #88 authored contract; §5.5); audit: ${JSON.stringify(auditLines())}`,
		);
	});

	it("operand absence: no held-hash run on the tool result, the audit trail, or the transcript (args residual excluded)", () => {
		requireOwnResult("operand-absence");
		for (const message of dispatchResults()) {
			assert.deepEqual(
				heldOperandRuns(JSON.stringify(message), heldHash),
				[],
				"operand-absence: the held operand reached a toolResult entry — an expected head in an " +
					"injectable context makes every later blind compare at that head echoable (§4.9, §1.6)",
			);
		}
		for (const line of auditLines()) {
			assert.deepEqual(
				heldOperandRuns(line, heldHash),
				[],
				"operand-absence: the held operand reached the audit trail (§3.8's refusal-record rule; §4.9)",
			);
		}
		assert.deepEqual(
			heldOperandRuns(transcriptSansCallArguments(readSessionEntries(fixture)), heldHash),
			[],
			"operand-absence: the held operand reached the session transcript outside the excluded " +
				"toolCall-arguments residual (§4.9's TRANSCRIPT ground)",
		);
	});
});

// ---------------------------------------------------------------------------
// The sweep's own teeth (§3.12 — both directions, synthetic strings).
// ---------------------------------------------------------------------------

describe("the operand sweep's own teeth (§3.12)", () => {
	const HELD = "0123456789abcdef0123456789abcdef01234567";

	it("flags a 7-char prefix of the held hash", () => {
		assert.deepEqual(heldOperandRuns("landed at 0123456 today", HELD), ["0123456"]);
	});

	it("flags the full held hash embedded inside a longer hex run", () => {
		assert.deepEqual(heldOperandRuns(`zz aa${HELD}bb zz`, HELD), [`aa${HELD}bb`]);
	});

	it("stays silent on an unrelated 7-hex run", () => {
		assert.deepEqual(heldOperandRuns("alongside deadbee7 inert", HELD), []);
	});

	it("flags a 6-char prefix — the sweep's floor is 4, mirroring the implementation's rule", () => {
		assert.deepEqual(heldOperandRuns("shorty 012345 rides", HELD), ["012345"]);
	});

	it("flags a 4-char slice — the floor itself", () => {
		assert.deepEqual(heldOperandRuns("tiny 89ab rides", HELD), ["89ab"]);
	});

	it("flags an interior slice of the held hash", () => {
		// A non-repetitive held hash: the periodic HELD's interior slices
		// contain its 7-prefix, which would let the prefix branch mask a
		// missing containment branch.
		const held = "9e107d9d372bb6826bd81d3542a419d6a5e10d9c";
		assert.deepEqual(heldOperandRuns(`interior ${held.slice(14, 26)} rides`, held), [held.slice(14, 26)]);
	});

	it("flags an uppercase spelling — the sweep case-folds before containment", () => {
		const lettersHeld = "fedcbafedcbafedcbafedcbafedcbafedcbafedc";
		assert.deepEqual(heldOperandRuns("shouty FEDCBAFEDCBA", lettersHeld), ["fedcbafedcba"]);
		assert.deepEqual(heldOperandRuns("control fedcbaf lands", lettersHeld), ["fedcbaf"]);
	});

	it("excludes the assistant toolCall-arguments field by name", () => {
		const entries: Array<Record<string, unknown>> = [
			{
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "zq_tool", arguments: { leak: HELD } }],
				},
			},
		];
		assert.deepEqual(heldOperandRuns(transcriptSansCallArguments(entries), HELD), []);
	});

	it("still flags the same operand on a toolResult entry — the exclusion is one field, not the transcript", () => {
		const entries: Array<Record<string, unknown>> = [
			{ message: { role: "toolResult", toolName: "zq_tool", content: [{ type: "text", text: HELD }] } },
		];
		assert.deepEqual(heldOperandRuns(transcriptSansCallArguments(entries), HELD), [HELD]);
	});

	it("keeps non-toolCall assistant content on the swept surface", () => {
		const entries: Array<Record<string, unknown>> = [
			{ message: { role: "assistant", content: [{ type: "text", text: `spoke ${HELD}` }] } },
		];
		assert.deepEqual(heldOperandRuns(transcriptSansCallArguments(entries), HELD), [HELD]);
	});
});
