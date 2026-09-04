/**
 * Harness smoke test — proves the harness itself and the two unverified
 * substrate assumptions BEFORE any AC suite rides on them (plan for issue
 * #32, "Risks"):
 *
 *   1. a multi-file extension (entry + `./probe/mod.ts`) loads under pi
 *      and both files execute;
 *   2. a symlinked extension entry still loads (the fixture links the
 *      runtime from the repository tree);
 *   3. D1 negative control: a probe that calls a pi action method in its
 *      factory produces pi's load-time failure class, detectably — if the
 *      class cannot be provoked, this suite FAILS as "detector cannot
 *      measure" (§3.9: an unmeasurable predicate refuses, never approves).
 *
 * Uses throwaway PROBE extensions generated here — never the gitjig runtime
 * — so its result depends on the harness and the substrate alone: a red here
 * means the measuring instrument is broken, never the runtime under test.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	isLoadTimeActionFailure,
	type PiRunResult,
	readSessionEntries,
	removeFixture,
	runPi,
	type ScriptTurn,
} from "./harness/run-pi.ts";

const PROBE_ENTRY = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markerFromModule } from "./probe/mod.ts";

export default function probe(pi: ExtensionAPI) {
	console.log(\`PROBE_ENTRY_LOADED \${markerFromModule()}\`);
	pi.on("session_start", () => {
		console.log("PROBE_SESSION_START");
	});
}
`;

const PROBE_MODULE = `export function markerFromModule(): string {
	return "PROBE_SUBMODULE_EXECUTED";
}
`;

const VIOLATING_ENTRY = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function violating(pi: ExtensionAPI) {
	// Deliberate violation: an action method during extension loading.
	pi.appendEntry("d1-load-time-violation", { at: Date.now() });
}
`;

const SMOKE_SCRIPT: ScriptTurn[] = [
	{ kind: "toolCall", name: "bash", arguments: { command: "echo SMOKE_TOOL_RAN" } },
	{ kind: "text", text: "SMOKE_DONE" },
];

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

describe("harness: multi-file probe extension via scripted provider", () => {
	let fixture: Fixture;
	let result: PiRunResult;

	before(async () => {
		fixture = buildFixture({
			script: SMOKE_SCRIPT,
			extensionFiles: { "probe.ts": PROBE_ENTRY, "probe/mod.ts": PROBE_MODULE },
		});
		result = await runPi(fixture);
	});
	after(() => removeFixture(fixture));

	it("completes headless with exit code 0", () => {
		assert.equal(result.exitCode, 0, diagnostics(result));
	});

	it("executes the entry file at load", () => {
		assert.match(result.stderr, /PROBE_ENTRY_LOADED/, diagnostics(result));
	});

	it("executes the second module of the multi-file extension", () => {
		assert.match(result.stderr, /PROBE_SUBMODULE_EXECUTED/, diagnostics(result));
	});

	it("fires session_start after load", () => {
		assert.match(result.stderr, /PROBE_SESSION_START/, diagnostics(result));
	});

	it("drives the scripted tool call through to a real tool result", () => {
		const entries = readSessionEntries(fixture);
		const hit = entries.some((entry) => JSON.stringify(entry).includes("SMOKE_TOOL_RAN"));
		assert.ok(hit, `no SMOKE_TOOL_RAN tool result in session JSONL\n${diagnostics(result)}`);
	});

	it("surfaces the scripted final text on stdout", () => {
		assert.match(result.stdout, /SMOKE_DONE/, diagnostics(result));
	});
});

describe("harness: symlinked extension entry (repo-tree load shape)", () => {
	let realDir: string;
	let fixture: Fixture;
	let result: PiRunResult;

	before(async () => {
		// Probe sources live OUTSIDE the fixture; only symlinks sit under
		// `.pi/extensions/` — the exact shape the AC suites use to load the
		// runtime from the repository tree. Both the entry and its module
		// directory are linked (as for `gitjig.ts` + `gitjig/`), so the suite
		// asserts observable load behavior without depending on whether the
		// loader resolves the entry's realpath.
		realDir = mkdtempSync(join(tmpdir(), "gitjig-probe-real-"));
		writeFileSync(join(realDir, "probe.ts"), PROBE_ENTRY);
		mkdirSync(join(realDir, "probe"));
		writeFileSync(join(realDir, "probe", "mod.ts"), PROBE_MODULE);
		fixture = buildFixture({
			script: [{ kind: "text", text: "SYMLINK_SMOKE_DONE" }],
			extensionLinks: { "probe.ts": join(realDir, "probe.ts"), probe: join(realDir, "probe") },
		});
		result = await runPi(fixture);
	});
	after(() => {
		removeFixture(fixture);
		rmSync(realDir, { recursive: true, force: true });
	});

	it("loads the extension through the symlink", () => {
		assert.match(result.stderr, /PROBE_ENTRY_LOADED PROBE_SUBMODULE_EXECUTED/, diagnostics(result));
	});

	it("still reaches session_start", () => {
		assert.match(result.stderr, /PROBE_SESSION_START/, diagnostics(result));
	});
});

describe("harness: D1 negative control — load-time action failure class", () => {
	let violatingFixture: Fixture;
	let cleanFixture: Fixture;
	let violatingResult: PiRunResult;
	let cleanResult: PiRunResult;

	before(async () => {
		violatingFixture = buildFixture({
			script: [{ kind: "text", text: "D1_SHOULD_NOT_BE_REACHED" }],
			extensionFiles: { "violating.ts": VIOLATING_ENTRY },
		});
		violatingResult = await runPi(violatingFixture);
		cleanFixture = buildFixture({
			script: [{ kind: "text", text: "D1_CLEAN_DONE" }],
			extensionFiles: { "probe.ts": PROBE_ENTRY, "probe/mod.ts": PROBE_MODULE },
		});
		cleanResult = await runPi(cleanFixture);
	});
	after(() => {
		removeFixture(violatingFixture);
		removeFixture(cleanFixture);
	});

	it("provokes pi's load-time failure class (else: detector cannot measure)", () => {
		assert.ok(
			isLoadTimeActionFailure(violatingResult),
			`detector cannot measure: the violating probe did not produce the load-time action failure class\n${diagnostics(violatingResult)}`,
		);
	});

	it("does not match a clean run (no false positive)", () => {
		assert.equal(isLoadTimeActionFailure(cleanResult), false, diagnostics(cleanResult));
	});
});
