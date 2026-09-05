/**
 * Hermetic pi integration suite for the command spine (issue #91; SPEC
 * §4.8 "The command layer" — the governed-home conjunct, the four-rung
 * surface rule, the uniqueness obligation; §4.9 for the dispatcher the
 * `review` command rides as one more call site).
 *
 * Every spine arm is RED until the Code phase lands the three assets —
 * `work-on` at `.pi/prompts/work-on.md`, `review` and `ship` as extension
 * commands registered from the gitjig entry — and each arm's first
 * assertion is authored to fail on exactly that absence: a missing
 * registration row, a missing session entry, a missing template file.
 * The route arms (headless command dispatch; the registration dump) and
 * the collision-mutant arms are green on this tree by design.
 *
 * REGISTRATION PROOF (AC 1–2). One session over a fixture that mirrors
 * the deployed layout — the committed runtime, prompts dir, and skills
 * dir symlinked in (`linkGitjigRuntime`/`linkPromptsDir`/`linkSkillsDir`;
 * dangling links are legal, the harness header owns that contract) — with
 * a probe extension that dumps every `pi.getCommands()` row at
 * `session_start` (§4.8's own measured instrument shape). The arms read
 * `name`/`source`/`sourceInfo.scope`/`sourceInfo.baseDir` from the
 * substrate's report and never infer ownership from a filename or a path
 * walk (§4.8's canonical-name rule). A governed-home row is one whose
 * `scope` is `project` AND whose `baseDir` is the fixture's `.pi`
 * (accepted under both the raw and the realpath spelling of the OS temp
 * root). Uniqueness is full-row-multiset equality of the governed-home
 * rows against the exact expected set; within the governed-home filter a
 * row's free cells are `name` and `source`, so the multiset is over those
 * pairs. Two collision-mutant fixtures prove the equality arm's teeth in
 * both directions — an extra extension registering `work-on`, and a
 * prompt-side `review.md` — each asserting the DETECTION: the poison row
 * is reported by the substrate AND the multiset differs from the expected
 * set. INVERSION: those two arms are green exactly when the matcher has
 * teeth, on this tree and after Code alike; a red there means the
 * substrate silently deduped that collision cell (§4.8's recorded
 * contingency — record, not patch).
 *
 * RUNG-1 ACTS (AC 3). A probe-first arm re-verifies the headless route in
 * suite: a throwaway registered command (`zz-probe`, its own fixture so it
 * adds no governed-home row to the registration fixture) is invoked via a
 * print-mode `/zz-probe <args>` prompt and must land its args in a file —
 * green now, so a spine arm's red can never be this route's defect. The
 * `review` round trip then runs against a git-inited caller fixture
 * carrying the runtime as COPIED bytes (the runtime resolves its repo
 * root by realpath, so symlinks would escape the fixture — the sibling
 * dispatch suite's measured ground) and a committed delegate script that
 * writes the bounded return; the delegate is a plain shell script, not a
 * child pi session — the delegate's child-session shape is the sibling
 * suite's subject, not re-proven here.
 *
 * AUTHORED PHASE-C CONTRACT (what the arms bind):
 *   - `review` is an extension command registered from the gitjig entry;
 *     its argument string is `<expectedRef> <delegateArgv…>`, whitespace-
 *     split; the handler dispatches through the ONE dispatcher (§4.9's
 *     one home, many call sites) and appends a session entry
 *     `customType: "gitjig-review"` whose data carries the disposition,
 *     the compare VALIDITY token (`confirmed`/`invalid`), and the admitted
 *     summary — never an operand; the dispatch acts land
 *     `"category":"dispatch"` audit records through the landed writer,
 *     the admission carrying `"action":"admitted"`.
 *   - `ship` is an extension command registered from the gitjig entry; it
 *     performs no merge and reaches no network; its registered
 *     `description` names the three offline undecidables — the
 *     platform-held review verdict, the platform-held AC state, and the
 *     merge act; on invocation it appends a session entry
 *     `customType: "gitjig-ship"` whose data carries a `composition`
 *     token, `"satisfied"` or `"unsatisfied"`, and a fact-less invocation
 *     composes `"unsatisfied"`. The fact GRAMMAR (how a caller supplies
 *     verdict/head/AC facts) is the Code phase's discretion and is
 *     deliberately NOT bound here: the arms bind the description row and
 *     the fact-less direction of the report shape, the loosest grammar
 *     that can bind the contract; the satisfied direction stays unbound
 *     until the grammar exists and is disclosed as such at the arm.
 *
 * TEMPLATE NORMS (AC 4). A lexical read of `.pi/prompts/work-on.md`'s
 * committed bytes: the issue-first-entry token (§1.1's standard flow) and
 * the Doc → Test → Code work-order pointer (§1.2) must be present.
 * "Points at the SPEC sections, not restated prose" is a review judgment
 * (§2.8) the lexical arm does NOT establish — disclosed at the arm.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. The uniqueness arm binds the three
 * `.pi/` surfaces the fixture mirrors; a project-skill home outside
 * `.pi/` (none exists in this repository) is outside the governed-home
 * filter by the conjunct's own `baseDir` limb. The operand sweep is
 * LEXICAL — case-folded ≥ 4-char hex runs held to containment against the
 * held operand, the dispatcher's own rule — over the caller fixture's
 * session entries, audit trail, and run output; a paraphrased or
 * re-encoded operand is §4.9's injectable-context residual. A green
 * `review` round trip says nothing about any delegate's quality: the
 * delegate is a fixed echo of the bounded-return shape.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
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

/** One text turn: a script for runs whose act is a command dispatch, not a model turn. */
const TEXT_ONLY_SCRIPT = [{ kind: "text" as const, text: "SPINE_RUN_DONE" }];

/** The expected governed-home multiset — §4.8's three worked cases on their ruled surfaces. */
const EXPECTED_GOVERNED_ROWS = ["review|extension", "ship|extension", "work-on|prompt"];

function redUntilLanded(arm: string, subject: string): string {
	return (
		`${arm}: red until the Code phase lands ${subject} (issue #91; SPEC §4.8's worked cases place ` +
		`work-on at .pi/prompts/work-on.md and review/ship as extension commands from the gitjig entry)`
	);
}

// ---------------------------------------------------------------------------
// Probe extensions (fixture-side sources; resolved only under pi's loader).
// ---------------------------------------------------------------------------

/**
 * The registration dump: every command-list row as one `CMDJSON` stderr
 * line at `session_start` (`getCommands` is an action method — legal in a
 * handler, never at load). Registers NO command itself, so it adds no row
 * to the surface it reports.
 */
const DUMP_PROBE_EXTENSION = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function dumpProbe(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		for (const command of pi.getCommands()) {
			console.error(
				"CMDJSON " +
					JSON.stringify({
						name: command.name,
						source: command.source,
						scope: command.sourceInfo.scope,
						baseDir: command.sourceInfo.baseDir,
						description: command.description,
					}),
			);
		}
	});
}
`;

/**
 * The headless-dispatch probe: a throwaway command whose handler writes
 * its args string into the fixture (plain fs — no action method), so a
 * print-mode `/zz-probe <args>` run leaves a readable proof of dispatch.
 */
const DISPATCH_PROBE_EXTENSION = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function dispatchProbe(pi: ExtensionAPI) {
	const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	pi.registerCommand("zz-probe", {
		description: "headless-dispatch probe (test-only)",
		handler: async (args: string) => {
			writeFileSync(join(fixtureRoot, "zz-probe-args.txt"), args);
		},
	});
}
`;

/** Collision mutant (a): an extension-side registration of the name `work-on`. */
const COLLIDE_EXTENSION = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function collide(pi: ExtensionAPI) {
	pi.registerCommand("work-on", {
		description: "zq collision mutant (test-only)",
		handler: async () => {},
	});
}
`;

// ---------------------------------------------------------------------------
// The caller fixture's committed runtime (copied bytes) and delegate.
// ---------------------------------------------------------------------------

/**
 * The committed runtime as bytes, walked from this repository's tree at
 * build time — `gitjig.ts` plus everything under `gitjig/`, the command
 * modules included once they land (the sibling dispatch suite's idiom).
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

const REVIEW_SUMMARY = "the review delegate composed its bounded return";

/**
 * The review arm's delegate: a plain shell script the dispatcher runs in
 * the provisioned clone; it reports the clone's own HEAD as the reviewed
 * head, so the caller-side compare against `expectedRef` must come back
 * `confirmed` — validity alone.
 */
const REVIEW_DELEGATE_SCRIPT = [
	"#!/bin/sh",
	'head=$(git rev-parse HEAD)',
	`printf '{"ok":true,"summary":"${REVIEW_SUMMARY}","reviewedHead":"%s"}' "$head" > ../return.json`,
	"",
].join("\n");

const GIT_FLAGS = ["-c", "user.name=zq", "-c", "user.email=zq@zq.zq", "-c", "commit.gpgsign=false"];

// ---------------------------------------------------------------------------
// Row readers over the dump probe's stderr.
// ---------------------------------------------------------------------------

interface CommandRow {
	name: string;
	source: string;
	scope?: string;
	baseDir?: string;
	description?: string;
}

function commandRows(run: PiRunResult): CommandRow[] {
	return run.stderr
		.split("\n")
		.filter((line) => line.startsWith("CMDJSON "))
		.map((line) => JSON.parse(line.slice("CMDJSON ".length)) as CommandRow);
}

/** Both spellings of the fixture's `.pi` — the OS temp root is itself a symlink on macOS. */
function governedBaseDirs(fixture: Fixture): Set<string> {
	return new Set([join(fixture.root, ".pi"), join(realpathSync(fixture.root), ".pi")]);
}

/** The governed-home filter: §4.8's conjunct, both limbs from the substrate's report. */
function governedRows(run: PiRunResult, fixture: Fixture): CommandRow[] {
	const accepted = governedBaseDirs(fixture);
	return commandRows(run).filter(
		(row) => row.scope === "project" && row.baseDir !== undefined && accepted.has(row.baseDir),
	);
}

/** The multiset the uniqueness arm compares: governed rows' free cells, sorted. */
function governedMultiset(run: PiRunResult, fixture: Fixture): string[] {
	return governedRows(run, fixture)
		.map((row) => `${row.name}|${row.source}`)
		.sort();
}

function diagnostics(run: PiRunResult): string {
	return `pi ${run.piVersion} exit=${run.exitCode} timedOut=${run.timedOut}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`;
}

// ---------------------------------------------------------------------------
// The operand sweep (lexical; the dispatcher's own rule, mirrored).
// ---------------------------------------------------------------------------

/**
 * Every hex run of ≥ 4 chars in `text`, either case, that touches the held
 * operand: each run is lowercased and flagged iff the held hash contains
 * it or it contains the held 7-prefix. Unrelated hex — session UUIDs,
 * other hashes — is left alone: the sweep pins the operand, not hex at
 * large. Teeth pinned in-suite below (§3.12).
 */
function heldOperandRuns(text: string, held: string): string[] {
	const runs = text.match(/[0-9a-fA-F]{4,}/g) ?? [];
	const prefix = held.slice(0, 7);
	return runs.map((run) => run.toLowerCase()).filter((run) => held.includes(run) || run.includes(prefix));
}

// ---------------------------------------------------------------------------
// Fixtures and runs — built once, read by every arm.
// ---------------------------------------------------------------------------

let probeFixture: Fixture;
let probeRun: PiRunResult;
let registrationFixture: Fixture;
let registrationRun: PiRunResult;
let mutantExtensionFixture: Fixture;
let mutantExtensionRun: PiRunResult;
let mutantPromptFixture: Fixture;
let mutantPromptRun: PiRunResult;
let callerFixture: Fixture;
let reviewRun: PiRunResult;
let shipRun: PiRunResult;
/** The compare operand: the caller fixture repo's HEAD. */
let heldHash: string;

before(async () => {
	// The headless-dispatch probe rides its own fixture so its throwaway
	// command never enters the registration fixture's governed-home rows.
	probeFixture = buildFixture({
		script: TEXT_ONLY_SCRIPT,
		extensionFiles: { "zz-dispatch-probe.ts": DISPATCH_PROBE_EXTENSION },
	});
	probeRun = await runPi(probeFixture, { prompt: "/zz-probe zq-probe-args-token", timeoutMs: 120_000 });

	// The deployed-layout mirror: runtime + prompts + skills, all symlinked;
	// the dump probe registers nothing.
	registrationFixture = buildFixture({
		script: TEXT_ONLY_SCRIPT,
		linkGitjigRuntime: true,
		linkPromptsDir: true,
		linkSkillsDir: true,
		extensionFiles: { "zz-dump-probe.ts": DUMP_PROBE_EXTENSION },
	});
	registrationRun = await runPi(registrationFixture, { timeoutMs: 120_000 });

	// Collision mutant (a): the mirror plus an extension-side `work-on`.
	mutantExtensionFixture = buildFixture({
		script: TEXT_ONLY_SCRIPT,
		linkGitjigRuntime: true,
		linkPromptsDir: true,
		linkSkillsDir: true,
		extensionFiles: { "zz-dump-probe.ts": DUMP_PROBE_EXTENSION, "zz-collide.ts": COLLIDE_EXTENSION },
	});
	mutantExtensionRun = await runPi(mutantExtensionFixture, { timeoutMs: 120_000 });

	// Collision mutant (b): a REAL prompts dir (the repo's prompt files
	// copied in when present, so post-Code the only deviation is the
	// poison) carrying a prompt-side `review.md`; the prompts link is off
	// because the poison must never be written through it into this
	// repository's tree.
	mutantPromptFixture = buildFixture({
		script: TEXT_ONLY_SCRIPT,
		linkGitjigRuntime: true,
		linkSkillsDir: true,
		extensionFiles: { "zz-dump-probe.ts": DUMP_PROBE_EXTENSION },
	});
	const poisonPromptsDir = join(mutantPromptFixture.root, ".pi", "prompts");
	mkdirSync(poisonPromptsDir, { recursive: true });
	const repoPromptsDir = join(repoRoot(), ".pi", "prompts");
	if (existsSync(repoPromptsDir)) {
		for (const item of readdirSync(repoPromptsDir, { withFileTypes: true })) {
			if (item.isFile()) {
				copyFileSync(join(repoPromptsDir, item.name), join(poisonPromptsDir, item.name));
			}
		}
	}
	writeFileSync(
		join(poisonPromptsDir, "review.md"),
		"zq poison prompt: a prompt-side collision with the extension command name\n",
	);
	mutantPromptRun = await runPi(mutantPromptFixture, { timeoutMs: 120_000 });

	// The caller fixture for the rung-1 acts: copied runtime bytes (the
	// runtime realpath-resolves its repo root, so the caller repo must BE
	// the fixture), a git-inited history carrying the delegate, and two
	// runs — `/review …` then `/ship` — whose session entries are told
	// apart by customType.
	callerFixture = buildFixture({ script: TEXT_ONLY_SCRIPT, extensionFiles: runtimeFileMap() });
	writeFileSync(join(callerFixture.root, "zq-delegate.sh"), REVIEW_DELEGATE_SCRIPT);
	writeFileSync(join(callerFixture.root, "zq-base.txt"), "zq command spine caller content\n");
	const git = (...args: string[]): string =>
		execFileSync("git", ["-C", callerFixture.root, ...GIT_FLAGS, ...args], { encoding: "utf8" });
	execFileSync("git", ["init", "-q", "-b", "main", callerFixture.root], { encoding: "utf8" });
	// Path-scoped on purpose: the parent's script.json, sessions/, state/,
	// home/, and pi-agent/ stay out of the history the dispatcher clones.
	git("add", ".pi", "zq-delegate.sh", "zq-base.txt");
	git("commit", "-q", "-m", "zq command spine caller fixture");
	heldHash = git("rev-parse", "HEAD").trim();
	reviewRun = await runPi(callerFixture, { prompt: "/review main sh zq-delegate.sh", timeoutMs: 180_000 });
	shipRun = await runPi(callerFixture, { prompt: "/ship", timeoutMs: 120_000 });
});

after(() => {
	for (const fixture of [probeFixture, registrationFixture, mutantExtensionFixture, mutantPromptFixture, callerFixture]) {
		if (fixture !== undefined) {
			removeFixture(fixture);
		}
	}
});

// ---------------------------------------------------------------------------
// Session-entry readers for the caller fixture's two runs.
// ---------------------------------------------------------------------------

function customEntries(fixture: Fixture, customType: string): Array<Record<string, unknown>> {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === customType,
	);
}

/** The review anchor: the command's OWN session entry, or the authored red. */
function requireReviewEntry(arm: string): Record<string, unknown> {
	const entries = customEntries(callerFixture, "gitjig-review");
	assert.equal(
		entries.length,
		1,
		`${redUntilLanded(arm, "the review extension command")} — no gitjig-review session entry crossed ` +
			`back from the /review dispatch\n${diagnostics(reviewRun)}`,
	);
	return entries[0] as Record<string, unknown>;
}

/** The ship anchor: the command's OWN session entry, or the authored red. */
function requireShipEntry(arm: string): Record<string, unknown> {
	const entries = customEntries(callerFixture, "gitjig-ship");
	assert.equal(
		entries.length,
		1,
		`${redUntilLanded(arm, "the ship extension command")} — no gitjig-ship session entry crossed back ` +
			`from the /ship invocation\n${diagnostics(shipRun)}`,
	);
	return entries[0] as Record<string, unknown>;
}

/** The registration anchor: exactly one governed-home row under `name`, or the authored red. */
function requireGovernedRow(arm: string, name: string, subject: string): CommandRow {
	const rows = governedRows(registrationRun, registrationFixture).filter((row) => row.name === name);
	assert.equal(
		rows.length,
		1,
		`${redUntilLanded(arm, subject)} — the substrate's command list reports no governed-home row named ` +
			`"${name}" (scope=project, baseDir=<fixture>/.pi); governed rows seen: ` +
			`${JSON.stringify(governedMultiset(registrationRun, registrationFixture))}\n${diagnostics(registrationRun)}`,
	);
	return rows[0] as CommandRow;
}

// ---------------------------------------------------------------------------
// The headless route (green by design — a spine red must never be this).
// ---------------------------------------------------------------------------

describe("the headless command-dispatch route (issue #91 AC 3's probe-first step)", () => {
	it("a registered command dispatches from a print-mode /command prompt", () => {
		const argsFile = join(probeFixture.root, "zz-probe-args.txt");
		assert.ok(
			existsSync(argsFile),
			`probe-route: /zz-probe never reached its handler in a headless -p run — the route every spine ` +
				`arm stands on is broken, so their reds would be harness defects, not subject absence\n${diagnostics(probeRun)}`,
		);
		assert.ok(
			readFileSync(argsFile, "utf8").includes("zq-probe-args-token"),
			`probe-route: the dispatched handler ran without its args — print-mode dispatch is not carrying ` +
				`the argument string\n${diagnostics(probeRun)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Registration on the governed home (AC 1).
// ---------------------------------------------------------------------------

describe("registration on the governed home, from the substrate's own report (issue #91 AC 1)", () => {
	it("the registration dump is readable (a dumb probe would red every row arm for the wrong reason)", () => {
		assert.ok(
			commandRows(registrationRun).length >= 1,
			`registration-dump: the dump probe reported no command rows at all — the arms below would then ` +
				`red because the instrument is blind, not because the spine is absent\n${diagnostics(registrationRun)}`,
		);
	});

	it("work-on registers as a prompt template on the governed home", () => {
		const row = requireGovernedRow("work-on-registration", "work-on", "the work-on prompt template at .pi/prompts/work-on.md");
		assert.equal(
			row.source,
			"prompt",
			`work-on-registration: work-on's row reports source=${row.source}, not prompt — §4.8's rungs answer ` +
				`no-no-yes for work-on, which places it on the prompt-template surface alone`,
		);
	});

	it("review registers as an extension command on the governed home", () => {
		const row = requireGovernedRow("review-registration", "review", "the review extension command");
		assert.equal(
			row.source,
			"extension",
			`review-registration: review's row reports source=${row.source}, not extension — §4.8's rung 1 ` +
				`returns on the blind compare and the caller-derived round count, acts no model may mediate`,
		);
	});

	it("ship registers as an extension command on the governed home", () => {
		const row = requireGovernedRow("ship-registration", "ship", "the ship extension command");
		assert.equal(
			row.source,
			"extension",
			`ship-registration: ship's row reports source=${row.source}, not extension — §4.8's rung 1 returns ` +
				`on the merge-boundary acts; the rung-2 yes is a recorded residual, never a second surface`,
		);
	});
});

// ---------------------------------------------------------------------------
// Cross-surface uniqueness (AC 2) and its mutants.
// ---------------------------------------------------------------------------

describe("cross-surface uniqueness over the governed home (issue #91 AC 2)", () => {
	it("the governed-home rows equal the expected multiset exactly", () => {
		assert.deepEqual(
			governedMultiset(registrationRun, registrationFixture),
			EXPECTED_GOVERNED_ROWS,
			`${redUntilLanded("uniqueness", "all three spine assets")} — full-row-multiset equality is what ` +
				`fails on every collision shape §4.8 measured (within-surface suffixing, cross-surface ` +
				`side-by-side rows, an alias's extra row) as well as on a missing asset\n${diagnostics(registrationRun)}`,
		);
	});

	// INVERSION (both mutant arms): these run against deliberately poisoned
	// fixtures and assert the DETECTION, so they are GREEN when the equality
	// matcher has teeth; a red here means the substrate silently deduped the
	// collision cell — §4.8's recorded contingency, to be recorded, not
	// patched, with the arm shape revisited then.
	it("mutant (a): an extension-side work-on collision is reported and breaks the equality", () => {
		const rows = governedRows(mutantExtensionRun, mutantExtensionFixture);
		assert.ok(
			rows.some((row) => row.name === "work-on" && row.source === "extension"),
			`uniqueness-mutant-a: the poison extension's work-on row is missing from the substrate's report — ` +
				`the substrate deduped an extension-side collision, so the equality arm cannot see this shape\n${diagnostics(mutantExtensionRun)}`,
		);
		assert.notDeepEqual(
			governedMultiset(mutantExtensionRun, mutantExtensionFixture),
			EXPECTED_GOVERNED_ROWS,
			"uniqueness-mutant-a: the poisoned fixture's multiset equals the expected set — the equality arm " +
				"would pass with a name collision present, so it has no teeth in the extension direction",
		);
	});

	it("mutant (b): a prompt-side review collision is reported and breaks the equality", () => {
		const rows = governedRows(mutantPromptRun, mutantPromptFixture);
		assert.ok(
			rows.some((row) => row.name === "review" && row.source === "prompt"),
			`uniqueness-mutant-b: the poison review.md's prompt row is missing from the substrate's report — ` +
				`the substrate deduped a prompt-side collision, so the equality arm cannot see this shape\n${diagnostics(mutantPromptRun)}`,
		);
		assert.notDeepEqual(
			governedMultiset(mutantPromptRun, mutantPromptFixture),
			EXPECTED_GOVERNED_ROWS,
			"uniqueness-mutant-b: the poisoned fixture's multiset equals the expected set — the equality arm " +
				"would pass with a prompt-side collision present, so it has no teeth in the prompt direction",
		);
	});
});

// ---------------------------------------------------------------------------
// The rung-1 acts (AC 3): the review round trip and the ship composition.
// ---------------------------------------------------------------------------

describe("the review round trip: /review dispatches the one dispatcher (issue #91 AC 3)", () => {
	it("the command's session entry crosses back from the dispatch", () => {
		const entry = requireReviewEntry("review-round-trip");
		assert.ok(
			JSON.stringify(entry).includes(REVIEW_SUMMARY),
			`review-round-trip: the admitted summary did not reach the review entry — the bounded return is ` +
				`the one thing that crosses back (§1.5, §4.9); entry: ${JSON.stringify(entry)}`,
		);
	});

	it("the compare surfaces as validity alone: 'confirmed', no operand named", () => {
		const entry = requireReviewEntry("review-compare");
		const serialized = JSON.stringify(entry);
		assert.ok(
			serialized.includes("confirmed"),
			`review-compare: the delegate reported the held head and the review entry does not say 'confirmed' — ` +
				`the caller consumes validity, never the pair (§1.6 via §4.9); entry: ${serialized}`,
		);
		assert.deepEqual(
			heldOperandRuns(serialized, heldHash),
			[],
			"review-compare: the review entry names the held operand — a compare outcome crosses back as " +
				"validity alone (§4.9's content-free return channels)",
		);
	});

	it("the dispatch chain lands category-dispatch audit records through the landed writer", () => {
		requireReviewEntry("review-audit");
		const lines = existsSync(callerFixture.auditFile) ? readAuditLines(callerFixture) : [];
		const dispatchLines = lines.filter((line) => line.includes('"category":"dispatch"'));
		assert.ok(
			dispatchLines.length >= 1,
			`review-audit: no "category":"dispatch" record on the audit trail — the /review call site rides ` +
				`the dispatcher, whose acts ride the landed writer (§4.9, §5.5); audit: ${JSON.stringify(lines)}`,
		);
		// The admission record is the chain's terminal act; a successful
		// provision→run→admit chain is what puts it there.
		assert.ok(
			dispatchLines.some((line) => line.includes('"action":"admitted"')),
			`review-audit: the dispatch trail carries no admission record — the provision→admission chain did ` +
				`not complete; dispatch records: ${JSON.stringify(dispatchLines)}`,
		);
	});

	it("operand absence: no held-hash run on the session entries, the audit trail, or the run output", () => {
		requireReviewEntry("review-operand-absence");
		for (const entry of readSessionEntries(callerFixture)) {
			assert.deepEqual(
				heldOperandRuns(JSON.stringify(entry), heldHash),
				[],
				"review-operand-absence: the held operand reached a session entry — an expected head in an " +
					"injectable context makes every later blind compare at that head echoable (§4.9, §1.6)",
			);
		}
		for (const line of existsSync(callerFixture.auditFile) ? readAuditLines(callerFixture) : []) {
			assert.deepEqual(
				heldOperandRuns(line, heldHash),
				[],
				"review-operand-absence: the held operand reached the audit trail (§3.8's refusal-record rule; §4.9)",
			);
		}
		for (const run of [reviewRun, shipRun]) {
			assert.deepEqual(
				heldOperandRuns(run.stdout + run.stderr, heldHash),
				[],
				"review-operand-absence: the held operand reached a run's terminal output — the command layer's " +
					"visible surfaces inherit the dispatcher's content-free channels (§4.9)",
			);
		}
	});
});

describe("the ship composition: caller-supplied facts, offline undecidables named (issue #91 AC 3)", () => {
	it("ship's registration record names the three offline undecidables", () => {
		const row = requireGovernedRow("ship-description", "ship", "the ship extension command");
		const description = row.description ?? "";
		// Lexical bind of the contract, not of any phrasing: the description
		// must name the platform-held review VERDICT, the platform-held AC
		// state, and the MERGE act as what ship cannot decide offline.
		for (const [token, undecidable] of [
			[/verdict/i, "the platform-held review verdict"],
			[/\bAC\b/, "the platform-held AC state"],
			[/merge/i, "the merge act"],
		] as Array<[RegExp, string]>) {
			assert.ok(
				token.test(description),
				`ship-description: the registered description does not name ${undecidable} — the registration ` +
					`record is where ship states what it cannot decide offline (issue #91 AC 3); got: "${description}"`,
			);
		}
	});

	it("a fact-less invocation composes 'unsatisfied' — the report distinguishes, in the direction the loosest grammar reaches", () => {
		// The fact GRAMMAR is the Code phase's discretion (header): this arm
		// binds the report SHAPE on the one invocation every grammar accepts —
		// no facts supplied — where the composition cannot be satisfied. The
		// satisfied direction is deliberately unbound until the grammar
		// exists; exact equality on the composition field (never containment:
		// "unsatisfied" contains "satisfied") is what makes this arm the
		// distinguishing half it claims.
		const entry = requireShipEntry("ship-composition");
		const data = (entry as { data?: { composition?: unknown } }).data;
		assert.equal(
			data?.composition,
			"unsatisfied",
			`ship-composition: a fact-less /ship did not report an unsatisfied composition — the composed ` +
				`report must distinguish a satisfied from an unsatisfied composition, and with no caller-supplied ` +
				`facts nothing the merge-boundary rows name is discharged; entry: ${JSON.stringify(entry)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// The work-on template's norms (AC 4).
// ---------------------------------------------------------------------------

describe("the work-on template carries the flow's entry and order (issue #91 AC 4)", () => {
	it("the committed template binds issue-first entry and the Doc → Test → Code order by §-pointer", () => {
		// Lexical arm over the committed bytes. What it does NOT establish:
		// "points at the SPEC sections, not restated prose" is a review
		// judgment (§2.8) — token presence cannot tell a pointer from a
		// restatement, and the reviewer owns that call.
		const templatePath = join(repoRoot(), ".pi", "prompts", "work-on.md");
		assert.ok(
			existsSync(templatePath),
			redUntilLanded("work-on-template", "the work-on prompt template at .pi/prompts/work-on.md"),
		);
		const template = readFileSync(templatePath, "utf8");
		assert.ok(
			template.includes("§1.1") && /issue/i.test(template),
			"work-on-template: the issue-first-entry token is missing — the template must enter through §1.1's " +
				"standard flow (work starts from an open, Active issue), by pointer",
		);
		assert.ok(
			template.includes("§1.2") && template.includes("Doc → Test → Code"),
			"work-on-template: the work-order token is missing — the template must carry the Doc → Test → Code " +
				"order as §1.2's pointer",
		);
	});
});

// ---------------------------------------------------------------------------
// The sweep helper's own teeth (§3.12 — minimal both-direction pins; the
// full battery for the identical rule lives in the sibling dispatch suite).
// ---------------------------------------------------------------------------

describe("the operand sweep's own teeth (§3.12)", () => {
	const HELD = "9e107d9d372bb6826bd81d3542a419d6a5e10d9c";

	it("flags a 7-char prefix and an interior slice of the held hash", () => {
		assert.deepEqual(heldOperandRuns("landed at 9e107d9 today", HELD), ["9e107d9"]);
		assert.deepEqual(heldOperandRuns(`interior ${HELD.slice(14, 26)} rides`, HELD), [HELD.slice(14, 26)]);
	});

	it("stays silent on an unrelated hex run", () => {
		assert.deepEqual(heldOperandRuns("alongside deadbee7 inert", HELD), []);
	});
});
