/**
 * Structural suite for the changelog fragment-gate's WORKFLOW half (issue #45).
 *
 * Subject under test: the text of `.github/workflows/check-changelog.yml`.
 *
 * The gate's predicate lives in two files. `.github/workflows/check-changelog.sh`
 * is driven end to end by `changelog-gate.unit.test.ts` through its
 * stdin-and-`--root` seam. The half that lives in this workflow — the trigger
 * set, the concurrency group, and the draft-sleep branch in the validate
 * step's `run:` block — has no seam at all: nothing in this tree can execute a
 * `run:` block, and building that seam is its own change (issue #49). Until it
 * exists, the workflow's contract is pinned as TEXT. SPEC §2.5 permits exactly
 * this and no more: "A contract testable only by grepping prose is stranded —
 * it moves into code both sides call. Structural checks over prose files
 * remain normal tests."
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only shape: a check that
 * does not establish a property says so, so a green run is never read as the
 * missing guarantee). Every assertion below is a claim about bytes on disk.
 * None of them is a claim about GitHub Actions' behaviour. Specifically, a
 * green run here does NOT establish:
 *
 *   1. That the workflow file is syntactically valid YAML, or that Actions
 *      accepts it. There is no YAML parser in this dependency-free tree (no
 *      `package.json` exists), so the readers below are narrow text scanners
 *      over a comment-stripped view, not a parse. They can be fooled by YAML
 *      this repository does not write — quoted keys, anchors, flow mappings,
 *      an inline `#` inside a quoted scalar. The cost is accepted in exchange
 *      for asserting nothing about indentation beyond block boundaries.
 *   2. That a workflow whose own trigger set has changed self-applies on the
 *      pull request carrying that change. Nothing in this tree can observe
 *      that; it is a platform property, and the only way to settle it is to
 *      push the change and read which activity type the resulting runs carry.
 *   3. What the branch-protection required-check rollup honours when several
 *      runs of one check name exist at a single head. The concurrency group
 *      asserted below is the mechanism intended to keep that set to one; that
 *      it succeeds is a platform property, unmeasured here.
 *   4. That the shell inside any `run:` block executes as intended. The
 *      draft-sleep assertions match a comparison SHAPE in shell text. They
 *      cannot evaluate it, and they do not trace dataflow beyond the one
 *      assignment each names.
 *
 * The one-tree limit also bounds what can be asserted at all. "The
 * `skip-changelog` short-circuit step is unchanged" and "`check-changelog.sh`
 * is unchanged" are claims about a DIFF; a unit test sees one tree, not two,
 * and a pinned hash of another file reds for edits that have nothing to do
 * with this contract. Neither is asserted as such. What is asserted instead is
 * the state invariant whose loss would actually matter — that the label bypass
 * is still wired ahead of the gate (W5) — and the script's untouched-ness is
 * carried by `changelog-gate.unit.test.ts` staying green and by review, not
 * by this file.
 *
 * This suite reads one file from disk and writes nothing: no network, no `gh`,
 * no `pi`, no fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const WORKFLOW = join(repoRoot(), ".github", "workflows", "check-changelog.yml");
const RAW = readFileSync(WORKFLOW, "utf8");

/**
 * The comment-free view. Every reader below works over this and never over
 * RAW, because the file's header comment NAMES the tokens several assertions
 * turn on — `ready_for_review`, `converted_to_draft`, `isDraft` — while
 * explaining the decisions behind them. A scan over RAW would report the
 * commentary as the configuration and every absence assertion would be
 * vacuously red while every presence assertion was vacuously green.
 */
const LINES = RAW.split("\n").filter((line) => !/^\s*#/.test(line));

const indentOf = (line: string): number => (line.match(/^\s*/) as RegExpMatchArray)[0].length;

/** A top-level mapping key and everything indented beneath it. */
function topLevelBlock(key: string): string[] {
	const start = LINES.findIndex((line) => line.startsWith(`${key}:`));
	if (start === -1) {
		return [];
	}
	const block = [LINES[start]];
	for (let i = start + 1; i < LINES.length; i += 1) {
		if (/^\S/.test(LINES[i])) {
			break;
		}
		block.push(LINES[i]);
	}
	return block;
}

/** The scalar to the right of `key:` inside a block, unquoted and trimmed. */
function scalar(block: string[], key: string): string | undefined {
	const line = block.find((candidate) => new RegExp(`^\\s*${key}:`).test(candidate));
	if (line === undefined) {
		return undefined;
	}
	// Only a MATCHED surrounding pair is stripped. A one-sided strip would eat
	// the closing quote of `steps.label.outputs.bypass != '1'`, whose value is
	// unquoted YAML ending in a quote character.
	const value = line.slice(line.indexOf(":") + 1).trim();
	return (value.match(/^'(.*)'$/) ?? value.match(/^"(.*)"$/))?.[1] ?? value;
}

/** Every `- ` item of the job's `steps:` sequence, as its own group of lines. */
function stepBlocks(): string[][] {
	const stepsIdx = LINES.findIndex((line) => /^\s+steps:\s*$/.test(line));
	if (stepsIdx === -1) {
		return [];
	}
	const stepsIndent = indentOf(LINES[stepsIdx]);
	const body: string[] = [];
	for (let i = stepsIdx + 1; i < LINES.length; i += 1) {
		const line = LINES[i];
		if (line.trim() !== "" && indentOf(line) <= stepsIndent) {
			break;
		}
		body.push(line);
	}
	const first = body.find((line) => /^\s*- /.test(line));
	if (first === undefined) {
		return [];
	}
	const itemIndent = indentOf(first);
	const steps: string[][] = [];
	for (const line of body) {
		if (indentOf(line) === itemIndent && /^\s*- /.test(line)) {
			steps.push([line]);
		} else if (steps.length > 0) {
			steps[steps.length - 1].push(line);
		}
	}
	return steps;
}

/**
 * The step that calls the gate script, identified by the call itself rather
 * than by its `name:`. The step's title is prose the Code phase may reword;
 * the call into `check-changelog.sh` is the thing that makes it this step.
 */
function validateStep(): string[] {
	return stepBlocks().find((step) => step.join("\n").includes("check-changelog.sh")) ?? [];
}

/** The step carrying the `skip-changelog` short-circuit, identified by its id. */
function labelStep(): string[] {
	return stepBlocks().find((step) => /^\s*id:\s*label\s*$/m.test(step.join("\n"))) ?? [];
}

/**
 * A step's shell text with backslash continuations folded away, so a condition
 * split across source lines for width is read as the one logical line it is.
 */
function shellLines(step: string[]): string[] {
	return step.join("\n").replace(/\\\n\s*/g, " ").split("\n");
}

/**
 * A comparison of an expansion against the literal `true` by exact string
 * equality — `[ "$X" = "true" ]`, `[[ $X == true ]]`, and the quoting variants
 * between. Whitespace around the operator is mandatory, which is what
 * separates a test from an assignment (`X=true` never matches), and `!=` is
 * excluded because no whitespace precedes its `=`.
 *
 * The capture is the compared variable's name. Matching this shape, rather
 * than the mere presence of the words, is the point: a truthiness test
 * (`[ -n "$X" ]`, `[ "$X" ]`) or a negated inequality does not match, and
 * those are exactly the forms under which an absent or degraded value reads
 * as asleep.
 */
const EQUALS_TRUE = /"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s+==?\s+"?true"?(?=[\s\];&]|$)/g;

/**
 * The conditional lines in the gate step that compare something against
 * `true`. This is how the draft-sleep branch is located: no other condition in
 * the step tests a boolean-valued string.
 */
function draftConditions(): string[] {
	return shellLines(validateStep()).filter(
		(line) => /^\s*(if|elif)\b/.test(line) && new RegExp(EQUALS_TRUE.source).test(line),
	);
}

/** The variables the draft-sleep condition compares against `true`, in order. */
function draftOperands(): string[] {
	const text = draftConditions().join("\n");
	return [...text.matchAll(EQUALS_TRUE)].map((match) => match[1]);
}

/** The step env var bound to the webhook payload's own draft field. */
function payloadDraftVar(): string | undefined {
	const line = validateStep().find((candidate) =>
		/^\s*[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{\s*github\.event\.pull_request\.draft\s*\}\}\s*$/.test(candidate),
	);
	return line?.trim().split(":")[0];
}

/** Every `--json` field list requested inside the gate step. */
function jsonFieldLists(): string[][] {
	return [...validateStep().join("\n").matchAll(/--json\s+([A-Za-z0-9_,]+)/g)].map((match) =>
		match[1].split(",").filter((field) => field !== ""),
	);
}

/** The `on.pull_request.types` sequence, in either the flow or the block form. */
function triggerTypes(): string[] {
	const block = topLevelBlock("on");
	const idx = block.findIndex((line) => /^\s*types:/.test(line));
	if (idx === -1) {
		return [];
	}
	const unquote = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "");
	const inline = block[idx].match(/\[([^\]]*)\]/);
	if (inline !== null) {
		return inline[1].split(",").map(unquote).filter((value) => value !== "");
	}
	const types: string[] = [];
	for (let i = idx + 1; i < block.length; i += 1) {
		if (!/^\s*- /.test(block[i])) {
			break;
		}
		types.push(unquote(block[i].replace(/^\s*- /, "")));
	}
	return types;
}

/**
 * W1 — the trigger set.
 *
 * The changelog floor binds from the ready transition onward (SPEC §1.3,
 * §2.3), so the gate must wake at that transition, and must NOT wake at the
 * transition back. The absence is asserted alongside the presence because the
 * omission is a decision: a `converted_to_draft` trigger would let the sleep
 * branch report a pass at a head an earlier ready-era run refused, without
 * that head changing. An absence nobody pins is an absence a later editor
 * completes the set out of.
 */
describe("W1 — the pull_request trigger set (SPEC §1.3, §2.3)", () => {
	it("wakes the gate on ready_for_review, the transition the sleep defers to", () => {
		assert.ok(triggerTypes().includes("ready_for_review"), `types: ${JSON.stringify(triggerTypes())}`);
	});

	it("stays asleep on converted_to_draft: re-drafting cannot turn a refusal into a pass at an unchanged head", () => {
		assert.ok(!triggerTypes().includes("converted_to_draft"), `types: ${JSON.stringify(triggerTypes())}`);
	});

	it("keeps every event the gate already fired on", () => {
		const required = ["opened", "synchronize", "reopened", "labeled", "unlabeled"];
		assert.deepEqual(required.filter((type) => !triggerTypes().includes(type)), []);
	});
});

/**
 * W2 — the concurrency group.
 *
 * Without it, a run queued while the pull request was still a draft can finish
 * after a ready-era run has already refused, and land a pass at the same head.
 * Cancelling the earlier run of the same group is what removes that ordering.
 */
describe("W2 — the per-PR concurrency group", () => {
	it("declares concurrency at the top level, so every run of the workflow joins the group", () => {
		assert.notEqual(topLevelBlock("concurrency").length, 0);
	});

	it("keys the group on the pull request number, so runs of one PR contend and runs of different PRs do not", () => {
		assert.match(scalar(topLevelBlock("concurrency"), "group") ?? "", /github\.event\.pull_request\.number/);
	});

	it("cancels the in-progress run of the group, so a draft-era run cannot outlive the ready-era one", () => {
		assert.equal(scalar(topLevelBlock("concurrency"), "cancel-in-progress"), "true");
	});
});

/**
 * W3 — the draft read is conjunctive and exact.
 *
 * The gate sleeps only when the webhook payload's draft field says true AND
 * the live `isDraft` says true. The conjunction is one-sided by design: either
 * source reading false runs the gate, so a disagreement can only refuse the
 * sleep, never grant it (SPEC §3.9 — ambiguity falls toward the block). Exact
 * string equality against `true` is what carries that: under a truthiness
 * test, an empty or degraded value from either source reads as asleep.
 */
describe("W3 — the draft-sleep condition in the gate step", () => {
	it("guards the sleep on a value compared against true", () => {
		assert.notEqual(draftConditions().length, 0);
	});

	it("takes the sleep only on a conjunction, so one source cannot grant it alone", () => {
		assert.match(draftConditions().join("\n"), /&&/);
	});

	it("compares exactly two values by exact string equality against true", () => {
		assert.equal(draftOperands().length, 2);
	});

	it("compares two distinct values, so the conjunction reads two sources rather than one twice", () => {
		assert.equal(new Set(draftOperands()).size, 2);
	});

	it("reads one side from the webhook payload's own draft field", () => {
		assert.ok(
			payloadDraftVar() !== undefined && draftOperands().includes(payloadDraftVar() as string),
			`payload var ${String(payloadDraftVar())} not among operands ${JSON.stringify(draftOperands())}`,
		);
	});

	it("reads the other side from a live isDraft value", () => {
		const live = draftOperands().filter((operand) => operand !== payloadDraftVar());
		const assigned = shellLines(validateStep()).some(
			(line) => live.length === 1 && new RegExp(`^\\s*${live[0]}=.*isDraft`).test(line),
		);
		assert.ok(assigned, `no isDraft assignment for ${JSON.stringify(live)}`);
	});

	/**
	 * The live extraction must not supply a default. `jq -r '.isDraft'` over a
	 * response missing the field yields the string `null`, which the equality
	 * above refuses — the gate runs. A `// true` alternative operator would
	 * silently convert that same degraded read into a sleep, which is the one
	 * direction §3.9 forbids: an unmeasurable input must never read as asleep.
	 * The equality assertion above cannot see this, because `// true` leaves
	 * the comparison shape untouched.
	 */
	it("takes the live value with no default, so a degraded read cannot mean draft", () => {
		const live = draftOperands().filter((operand) => operand !== payloadDraftVar());
		const assignment = shellLines(validateStep()).find(
			(line) => live.length === 1 && new RegExp(`^\\s*${live[0]}=.*isDraft`).test(line),
		);
		assert.ok(assignment, `no isDraft assignment for ${JSON.stringify(live)}`);
		assert.doesNotMatch(
			assignment,
			/\/\//,
			"the live isDraft extraction carries a jq alternative operator, which would default a degraded read",
		);
	});
});

/**
 * W6 — the sleep says so.
 *
 * §5.3 requires a sleeping gate to sleep clean AND say so, and §3.9 requires a
 * gate that is not enforcing to be distinguishable from one that passed. The
 * sleep concludes the job `success`, so the disclosure is the only thing that
 * separates the two states for a reader. Neither the trigger assertions nor
 * the condition assertions above notice its removal: a sleep branch stripped
 * of both lines is still a correctly-guarded sleep, and silently a pass.
 */
describe("W6 — the sleep's disclosure", () => {
	/**
	 * The branch body alone — from the guarding `if` to its own `fi`, never to
	 * the end of the step. Without the end bound these assertions would be
	 * satisfied by a disclosure sitting anywhere in the ENFORCING path below
	 * the branch, so moving both lines past the `fi` would leave a silent sleep
	 * and a green suite: the exact shape this block's header says it catches.
	 * A `/g` regex carries `lastIndex` between calls, so the source is re-wrapped
	 * rather than `.test()`-ed directly.
	 */
	const sleepBranch = (): string => {
		const lines = shellLines(validateStep());
		const guard = new RegExp(EQUALS_TRUE.source);
		const start = lines.findIndex((line) => guard.test(line));
		if (start === -1) {
			return "";
		}
		const opensAt = indentOf(lines[start]);
		const end = lines.findIndex(
			(line, i) => i > start && /^\s*fi\s*$/.test(line) && indentOf(line) === opensAt,
		);
		return lines.slice(start, end === -1 ? lines.length : end).join("\n");
	};

	it("warns on the surface a merge decision reads", () => {
		assert.match(sleepBranch(), /::warning::/);
	});

	it("records the sleep in the job summary", () => {
		assert.match(sleepBranch(), /GITHUB_STEP_SUMMARY/);
	});
});

/**
 * W4 — where the live value comes from.
 *
 * `isDraft` is a field of the metadata fetch the gate step already makes, not
 * a second call: a second fetch doubles the surface a flaky external call can
 * red, and the retry wrapper already covers the first one.
 */
describe("W4 — the gate step's metadata fetch", () => {
	it("makes exactly one --json request, so the live draft read costs no second fetch", () => {
		assert.equal(jsonFieldLists().length, 1);
	});

	it("asks that request for isDraft", () => {
		assert.deepEqual(jsonFieldLists().filter((fields) => fields.includes("isDraft")).length, 1);
	});
});

/**
 * W5 — the skip-changelog bypass stays wired ahead of the gate.
 *
 * Not a diff claim: this suite sees one tree and cannot say the step is
 * "unchanged". It asserts the state that the bypass depends on — the label
 * step still publishes the bypass output, and the gate step still runs only
 * when that output is unset. Both read correctly as invariants of the file at
 * rest, which is what the sleep branch must not have displaced.
 */
describe("W5 — the skip-changelog short-circuit", () => {
	it("publishes a bypass output when the skip-changelog label is present", () => {
		assert.match(labelStep().join("\n"), /skip-changelog[\s\S]*bypass=1[\s\S]*GITHUB_OUTPUT/);
	});

	it("runs the gate step only when that bypass output is unset", () => {
		assert.match(scalar(validateStep(), "if") ?? "", /steps\.label\.outputs\.bypass\s*!=\s*'1'/);
	});
});
