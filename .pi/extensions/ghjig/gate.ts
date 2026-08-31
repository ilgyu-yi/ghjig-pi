/**
 * The protected-branch gate — composition (SPEC §3.5, §3.8, §3.9, §3.11).
 *
 * Composition is homed here and nowhere else: `command-parse.ts` reads the
 * command, `gitref.ts` reads the repository, `protected.ts` owns the
 * predicate. None of them decides, and this module holds no second copy of
 * what they own.
 *
 * Two entry points, one composition:
 *
 *   - `decideCommand` is the ARMED decision. It is pure and synchronous and
 *     takes no state root, so nothing it reads can turn a block into an
 *     allow (§3.8).
 *   - `applyGate` is the ENFORCED decision. It takes the armed verdict and
 *     records it. There is no in-session instrument between the two: a
 *     block blocks, and §3.8 places this class's door at the session
 *     boundary, where the tiers below hold the record.
 *
 * **Order-independence** (§3.11): allow is non-terminal and both block and
 * refuse terminate, so no ordering of decisions within a session converts a
 * block into an allow. Every guarded action meets the armed gate again,
 * whatever the one before it decided.
 *
 * **Allow arms are named, never fall-throughs**: `not-a-git-command`,
 * `detached-head` (a detached commit advances no branch),
 * `push-nothing-configured`, and `topic-branch`. A verdict that fell out
 * of the end of a chain would be unattributable, and §3.8 requires every
 * decision to name its arm.
 *
 * **Two failure shapes, two messages** (§3.11): a block says the target IS
 * the protected branch and names the topic-branch → PR path with the
 * `/ghjig-topic` affordance that creates one; a refusal says the target
 * could not be measured and names the recovery that is live for the arm
 * that refused — "the evidence is missing" and "the lookup failed" have
 * different remedies.
 *
 * **Scope** (§4.6): the gate is live at the governed root and below it.
 * Outside it — a working directory that root does not contain, or no
 * repository at the working directory at all — and inside a repository
 * nested BELOW that root, whose ref store is its own (§4.7), the gate is
 * transparently inert: a guardrail, not a sandbox. Nothing is examined
 * there, so nothing is recorded and nothing is created.
 *
 * **This gate executes no subprocess.** Every reading it stands on is a
 * file read, so the decision cannot be redirected by whatever a spawned
 * program would resolve differently.
 *
 * **Bypass vectors deliberately not modelled** are enumerated as declared
 * deferrals in `residuals.ts`, which is the enumeration — this gate holds
 * no second copy of its membership, because a list restated in prose
 * diverges from the data on the first entry added to one and not the
 * other, and §3.11 gives a property one home. What belongs here is why
 * this gate enumerates at all: a residual is a path this tier never sees,
 * not a dependency that failed, so it carries no posture and no fail
 * direction — there is no miss to decide — and each one names the tier
 * below where the coverage is homed instead. Read as one pair: this
 * module's decisions, and the vectors it declares outside them.
 *
 * This tier is in-session mistake prevention (§3.2): it narrows the loop
 * for work performed inside a session, and the tiers below it are what
 * bind every actor.
 */
import { dirname } from "node:path";
import { appendAuditRecord } from "./audit.ts";
import { parseGitCommand } from "./command-parse.ts";
import {
	effectivePushDefault,
	findGitEntry,
	type GitLayout,
	readHead,
	readLayout,
	upstreamBranchRef,
} from "./gitref.ts";
import { isStrictDescendant, physical } from "./locate.ts";
import { posture } from "./postures.ts";
import { decideProtectedRef, decideProtectedRefPresence, PROTECTED_BRANCH_CATEGORY } from "./protected.ts";
import { ensureStateRoot } from "./state-root.ts";

export type GateDecision = "allow" | "block" | "refuse";

export interface GateVerdict {
	decision: GateDecision;
	/** The deciding arm — what makes the decision attributable (§3.8). */
	arm: string;
	/** What the actor is told, including the recovery live for this arm. */
	message: string;
}

export interface GateInput {
	cwd: string;
	command: string;
	/**
	 * The root of the repository under governance, where the caller knows it
	 * — parameterised the way `locateRepoRootFrom` parameterises discovery,
	 * so the scope a decision is taken in is an input rather than something
	 * this module goes and finds for itself (§4.6).
	 */
	governedRoot?: string;
}

export interface GateApplication extends GateInput {
	stateRoot: string;
}

const PREFIX = `[ghjig] ${PROTECTED_BRANCH_CATEGORY}`;

/**
 * The affordance a block names as its next step. Exported so a reader
 * checking that a block carries its recovery names it from here rather than
 * restating the spelling — one name, moved by one rename (§3.11).
 */
export const AFFORDANCE_COMMAND = "/ghjig-topic";

/** The block's positive remediation — the compliant path and the affordance. */
const BLOCK_RECOVERY =
	`Recovery: move the work to a topic branch and open a PR — \`${AFFORDANCE_COMMAND} <slug>\` creates one and ` +
	"switches to it, and the same commit is allowed there (SPEC §1.1, §3.3).";

function allow(arm: string, message: string): GateVerdict {
	return { decision: "allow", arm, message };
}

function block(arm: string, what: string): GateVerdict {
	return { decision: "block", arm, message: `${PREFIX}: ${what} ${BLOCK_RECOVERY}` };
}

function refuse(arm: string, what: string, recovery: string): GateVerdict {
	return {
		decision: "refuse",
		arm,
		message: `${PREFIX}: ${what}, so this command is not approved — an input that cannot be measured refuses rather than passes (§3.9). Recovery: ${recovery}.`,
	};
}

/** The gate's own scope: which repository, if any, this command acts on. */
type Scope =
	| { kind: "inert" }
	| { kind: "live"; layout: GitLayout }
	| { kind: "unresolvable"; why: string };

/** True iff `candidate` is `ancestor` itself or sits below it — physically, never by prefix. */
function isAtOrBelow(candidate: string, ancestor: string): boolean {
	const here = physical(candidate);
	const root = physical(ancestor);
	return here === root || isStrictDescendant(here, root);
}

/**
 * Resolves the repository the command would act on, inside `governedRoot`.
 *
 * Scope is anchored at the governed root: a working directory that is
 * neither that root nor a descendant of it is outside it, and enforcement
 * there is transparently inert — a guardrail, not a sandbox (§4.6). The
 * anchor is the whole predicate for the outer edge, so a governed
 * repository that happens to sit inside another checkout is still governed:
 * "is anything above me also a repository" answers a different question.
 *
 * The enclosing-repository test survives in the one role §4.7 gives it: a
 * repository nested BELOW the governed root keeps its own ref store and its
 * own configuration, and a repository binds at its root only, never
 * recursively into subprojects — so the gate is inert there. It decides
 * nothing about the governed root itself, and it is asked only of a
 * repository that sits strictly below that root.
 *
 * A working directory in no repository is inert as well. Inertness is by
 * design, never a degraded check.
 *
 * Where no root is named, the repository containing the working directory
 * is the subject, and every enclosing repository is read as an outer one:
 * "foreign" is a relation, and a caller that names no root has given the
 * working directory nothing to be foreign to. Naming the root is what the
 * production call site does; nothing else about the decision — least of
 * all where its evidence is kept — takes part in this answer. What a
 * decision governs and where its record lands are independent, and a scope
 * that read the store would answer one way under a relocated store and
 * another way in operation, leaving the operational path unmeasured
 * (§3.12).
 */
function resolveScope(cwd: string, governedRoot: string | undefined): Scope {
	const entry = findGitEntry(cwd);
	if (!entry.ok) {
		return { kind: "inert" };
	}
	if (governedRoot !== undefined && !isAtOrBelow(cwd, governedRoot)) {
		return { kind: "inert" };
	}
	const layout = readLayout(entry.value);
	if (!layout.ok) {
		return { kind: "unresolvable", why: layout.why };
	}
	const repositoryRoot = dirname(entry.value);
	// The test applies to a repository that sits BELOW the governed root, and
	// to no other. Where no root is named there is nothing to say this
	// repository is the governed one, so every enclosing repository is read as
	// an outer one — the unanchored reading, unchanged.
	const mayBeASubproject =
		governedRoot === undefined || isStrictDescendant(physical(repositoryRoot), physical(governedRoot));
	if (mayBeASubproject) {
		const enclosing = findGitEntry(dirname(repositoryRoot));
		// Bounded by the governed root: a repository ABOVE that root is not the
		// outer repository of a subproject, it is whatever the governed tree
		// happens to be checked out inside, and §4.6 does not scope enforcement
		// by that.
		if (enclosing.ok && (governedRoot === undefined || isAtOrBelow(dirname(enclosing.value), governedRoot))) {
			const outer = readLayout(enclosing.value);
			// A linked worktree shares its ref store with the repository it
			// belongs to, and is governed with it; a nested repository has a
			// store of its own, and is not.
			if (outer.ok && outer.value.commondir !== layout.value.commondir) {
				return { kind: "inert" };
			}
		}
	}
	return { kind: "live", layout: layout.value };
}

/** What the command lands on, once the repository has answered. */
type Target =
	| { kind: "ref"; ref: string }
	| { kind: "whole-repository" }
	| { kind: "verdict"; verdict: GateVerdict };

/** The branch HEAD names, or the arm that decides without one. */
function targetFromHead(layout: GitLayout): Target {
	const head = readHead(layout);
	if (!head.ok) {
		return {
			kind: "verdict",
			verdict: refuse(
				"head-unreadable",
				`this repository's HEAD cannot be read (${head.why}) [${posture("ref-identity").dependency}]`,
				"restore HEAD (`git symbolic-ref HEAD refs/heads/<branch>`) so the target can be measured",
			),
		};
	}
	if (head.value.kind === "detached") {
		return {
			kind: "verdict",
			verdict: allow(
				"detached-head",
				`${PREFIX}: HEAD is detached, so this command advances no branch.`,
			),
		};
	}
	return { kind: "ref", ref: head.value.ref };
}

/** The ref a bare push lands on, resolved through the effective configuration. */
function targetFromPushConfiguration(layout: GitLayout): Target {
	const configured = effectivePushDefault(layout);
	if (!configured.ok) {
		return {
			kind: "verdict",
			verdict: refuse(
				"push-default-unresolvable",
				`what a bare push lands on cannot be determined (${configured.why}) ` +
					`[${posture("push-target-resolution").dependency}]`,
				"name the target explicitly (`git push <remote> <branch>`)",
			),
		};
	}
	const value = configured.value;
	if (value === "simple" || value === "current") {
		// Both push the branch HEAD names: `current` by definition, and `simple`
		// because it pushes to a same-named branch and errors on a mismatch.
		return targetFromHead(layout);
	}
	if (value === "upstream" || value === "tracking") {
		// The destination is the branch this one integrates with, whose NAME MAY
		// DIFFER from HEAD's: a topic branch tracking the default branch pushes
		// onto the default branch, and resolving through HEAD would answer about
		// a branch this push never touches. An upstream that cannot be resolved
		// leaves the destination unmeasured, which refuses (§3.9).
		const head = readHead(layout);
		if (!head.ok || head.value.kind === "detached") {
			return targetFromHead(layout);
		}
		const upstream = upstreamBranchRef(layout, head.value.ref);
		if (!upstream.ok) {
			return {
				kind: "verdict",
				verdict: refuse(
					"push-upstream-unresolvable",
					`a bare push here lands on this branch's upstream, which cannot be named (${upstream.why}) ` +
						`[${posture("push-target-resolution").dependency}]`,
					"name the target explicitly (`git push <remote> <branch>`), or configure this branch's upstream",
				),
			};
		}
		return { kind: "ref", ref: upstream.value };
	}
	if (value === "matching") {
		return { kind: "whole-repository" };
	}
	if (value === "nothing") {
		return {
			kind: "verdict",
			verdict: allow("push-nothing-configured", `${PREFIX}: a bare push is configured to push no ref.`),
		};
	}
	return {
		kind: "verdict",
		verdict: refuse(
			"push-default-unrecognised",
			`what a bare push lands on is configured as "${value}", which this reading does not model ` +
				`[${posture("push-target-resolution").dependency}]`,
			"name the target explicitly (`git push <remote> <branch>`)",
		),
	};
}

/** The destination ref a refspec names on the far end. */
function targetFromRefSpec(layout: GitLayout, refSpec: string): Target {
	const spec = refSpec.startsWith("+") ? refSpec.slice(1) : refSpec;
	const parts = spec.split(":");
	if (parts.length > 2) {
		return {
			kind: "verdict",
			verdict: refuse(
				"unreadable-refspec",
				`the refspec names no single destination [${posture("command-parse").dependency}]`,
				"name the destination as `<source>:<destination>`",
			),
		};
	}
	const destination = (parts.length === 2 ? parts[1] : parts[0]).trim();
	if (destination === "") {
		return {
			kind: "verdict",
			verdict: refuse(
				"unreadable-refspec",
				`the refspec names no destination [${posture("command-parse").dependency}]`,
				"name the destination as `<source>:<destination>`",
			),
		};
	}
	if (destination === "HEAD") {
		return targetFromHead(layout);
	}
	return { kind: "ref", ref: destination.startsWith("refs/") ? destination : `refs/heads/${destination}` };
}

interface InternalVerdict {
	verdict: GateVerdict;
	/** False where the gate was inert: nothing examined, nothing recorded. */
	examined: boolean;
	/** The guarded action, where one was read — what the record names. */
	action?: "commit" | "push";
	/** The ref the decision was taken about, where one was resolved. */
	target?: string;
}

function decideInternal(input: GateInput): InternalVerdict {
	const scope = resolveScope(input.cwd, input.governedRoot);
	if (scope.kind === "inert") {
		return {
			verdict: allow("outside-governed-scope", `${PREFIX}: no governed repository here; enforcement is inert.`),
			examined: false,
		};
	}
	if (scope.kind === "unresolvable") {
		return {
			verdict: refuse(
				"repository-layout-unresolvable",
				`this repository's ref store cannot be located (${scope.why}) [${posture("git-commondir").dependency}]`,
				"repair the repository's git directory so its refs can be read",
			),
			examined: true,
		};
	}

	const parsed = parseGitCommand(input.command);
	if (parsed.kind === "none") {
		return {
			verdict: allow("not-a-git-command", `${PREFIX}: this command lands on no ref.`),
			examined: true,
		};
	}
	if (parsed.kind === "undecidable") {
		return {
			verdict: refuse(
				"undecidable-command",
				`what this command lands on is not fixed by the command itself (${parsed.why}) ` +
					`[${posture("command-parse").dependency}]`,
				"make the target explicit — run the guarded action as its own command, with the ref spelled out",
			),
			examined: true,
		};
	}

	const target =
		parsed.action === "commit"
			? targetFromHead(scope.layout)
			: parsed.refSpec === null
				? targetFromPushConfiguration(scope.layout)
				: targetFromRefSpec(scope.layout, parsed.refSpec);

	if (target.kind === "verdict") {
		return { verdict: target.verdict, examined: true, action: parsed.action };
	}

	const protection =
		target.kind === "whole-repository"
			? decideProtectedRefPresence(scope.layout)
			: decideProtectedRef(scope.layout, target.ref);
	const named = target.kind === "whole-repository" ? "every matching branch" : target.ref;

	if (protection.kind === "unresolvable") {
		const arm = protection.postureKey === "default-branch-source" ? "default-branch-unnamed" : "ref-identity-undecided";
		return {
			verdict: refuse(arm, `${protection.why} [${posture(protection.postureKey).dependency}]`, protection.recovery),
			examined: true,
			action: parsed.action,
			target: named,
		};
	}
	if (protection.kind === "protected") {
		const arm = target.kind === "whole-repository" ? "push-matching-target" : "protected-ref-target";
		return {
			verdict: block(
				arm,
				target.kind === "whole-repository"
					? "a bare push here lands on every matching branch, the repository's default branch among them."
					: "this command lands on the branch this repository treats as its default.",
			),
			examined: true,
			action: parsed.action,
			target: named,
		};
	}
	return {
		verdict: allow("topic-branch", `${PREFIX}: this command lands on a topic branch.`),
		examined: true,
		action: parsed.action,
		target: named,
	};
}

/**
 * The armed decision: what the gate says about `command` in `cwd`.
 *
 * Pure and synchronous. It reads no configuration of its own, no
 * environment, and no file — there is nothing here for a state to disarm
 * (§3.8).
 */
export function decideCommand(input: GateInput): GateVerdict {
	return decideInternal(input).verdict;
}

/** Records one decision, naming its arm. Never carries the guarded content (§5.5). */
function record(stateRoot: string, verdict: GateVerdict, detail: string): void {
	// The state root is created here because this is the gate's own
	// operational write, and a record that cannot land is a decision no
	// reader can distinguish from an absence.
	let declined = false;
	try {
		declined = !ensureStateRoot(stateRoot);
	} catch {
		// Creation is best-effort: the append below reports its own outcome,
		// and additive observability never moves a fail direction (§3.8). A
		// create the filesystem refused is not a claim that was declined, so
		// this path still appends and lets the sink report what happened.
	}
	if (declined) {
		// A named component of the state root is a link, and creation said so
		// with its remedy. Appending here would write the evidence through the
		// very entry the decline refused to follow (§4.6), so the record is not
		// taken — the decision itself is already computed and returns unchanged,
		// because evidence that cannot be recorded never moves a fail direction
		// (§3.8, §3.9): a block still blocks.
		return;
	}
	appendAuditRecord(stateRoot, {
		category: PROTECTED_BRANCH_CATEGORY,
		action: verdict.decision,
		arm: verdict.arm,
		text: detail,
	});
}

/**
 * The enforced decision: the armed verdict, then the record.
 *
 * The verdict is computed in full before any append, so a failing record
 * write can never move the decision (§3.8). Every verdict travels this one
 * path — a block returns the block it was decided as, and no state read
 * here stands between the decision and the caller.
 */
export function applyGate(input: GateApplication): GateVerdict {
	const decided = decideInternal(input);
	if (!decided.examined) {
		return decided.verdict;
	}
	const shape = `action=${decided.action ?? "none"} target=${decided.target ?? "none"}`;
	record(input.stateRoot, decided.verdict, `${decided.verdict.arm}; ${shape}`);
	return decided.verdict;
}
