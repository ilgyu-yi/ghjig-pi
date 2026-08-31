/**
 * State-root resolution and creation (SPEC §5.5, §4.6, §4.7).
 *
 * Resolution creates nothing. With no seam set, the operational root
 * `<repo>/.ghjig/state/` is computed and returned; creation is a separate,
 * named act (`ensureStateRoot`), so a caller that only resolves can never
 * leave a directory behind.
 *
 * `GHJIG_TEST_STATE_ROOT` is the only environment variable THIS module
 * reads, and the only channel anywhere that relocates the state root;
 * the name marks it test-only, and an active seam is reported
 * (`seamActive: true`) so the entry can announce it (§5.9). Other modules
 * read the environment for their own reasons — the configuration reader
 * consults the variables that select which git configuration FILES decide
 * a value — so the claim here is about this seam's role, not about a
 * count of channels that a later reading would silently expire (§1.10).
 * The seam stays readable — this module bounds the RANGE of the values it
 * accepts, it does not gate the read.
 *
 * Admissible-target policy (§5.5, §4.6): an admissible seam target is an
 * absolute, existing directory that is NEITHER the governed repository
 * root, NOR a strict descendant of it, NOR an ancestor of it. The state
 * root is where this shell keeps its own evidence, so a root that can be
 * pointed anywhere inside the governed tree writes that evidence surface
 * into the very tree under governance, and a test-only seam has no
 * business naming a directory of that repository. An ancestor is the same
 * boundary from the other side: a state root there CONTAINS the governed
 * repository, so creating it writes a rule over a directory the shell does
 * not govern (§4.7) and what it holds reaches wider than the tree the
 * shell was pointed at. Both exclusions are decided by the same
 * descendancy predicate the root walk uses (`isStrictDescendant`), on
 * physically resolved paths — never by a string prefix, which would
 * swallow a sibling directory that merely shares the root's spelling
 * (§3.11 predicate ownership).
 *
 * Fail posture (§3.9, `seam-target` row): a seam that is set but
 * unusable — empty, relative, missing, not a directory, or standing in
 * either containment relation to the governed tree — REFUSES the run.
 * Falling back would write the operational evidence surface from a test
 * context, exactly what §5.5 forbids. "Set" is decided on presence alone,
 * so an empty value is present-and-unmeasurable and refuses like any other
 * unusable value; only an UNSET seam takes the fail-open arm and returns
 * the operational root with `seamActive: false`.
 *
 * Every refusal names its own live recovery (§3.11), because the
 * surrounding substrate otherwise offers the operator only a total
 * extension-layer disarm — and the in-tree refusal names a DIFFERENT one
 * from the unusable-target refusals, since "point it at an existing
 * absolute directory" is dead advice for a target that already is one.
 */
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isStrictDescendant, locateRepoRoot, physical } from "./locate.ts";

/** The single test-only override seam — this module's only env read. */
export const STATE_SEAM = "GHJIG_TEST_STATE_ROOT";

/** The two components the shell itself names under a governed root. */
const SHELL_DIR_NAME = ".ghjig";
const STATE_DIR_NAME = "state";

/** Owner-only: the state root holds this shell's own evidence (§4.6). */
const STATE_MODE = 0o700;

/**
 * The exclusion written INTO the created directory (§4.7).
 *
 * Shell-created untracked files are excluded at creation, not by
 * convention: the rule travels with the directory, so it holds in a clone
 * whose own ignore file says nothing, and it ignores itself, so the act of
 * excluding leaves nothing behind to commit.
 */
const EXCLUSION_FILE_NAME = ".gitignore";
const EXCLUSION_CONTENT =
	"# Runtime state created by the shell, excluded at creation rather than by convention (§4.7).\n" +
	"# The pattern covers this file too: excluding leaves nothing to commit.\n" +
	"*\n";

export interface StateRootResolution {
	/** Absolute path of the state root; nothing under it is created here. */
	root: string;
	/** True iff the test-only seam supplied the root. */
	seamActive: boolean;
}

/** The live recovery the unusable-target refusals name (§3.11). */
const RECOVERY =
	`Recovery: unset ${STATE_SEAM} to use the operational state root, ` +
	`or point it at an existing absolute directory.`;

/** The live recovery for a target that IS a directory, but the wrong one (§3.11). */
const OUT_OF_TREE_RECOVERY =
	`Recovery: point ${STATE_SEAM} at a disposable directory outside the governed repository ` +
	`(a temporary directory is the usual choice), or unset it to use the operational state root.`;

export function resolveStateRoot(): StateRootResolution {
	const seam = process.env[STATE_SEAM];
	if (seam === undefined) {
		return { root: join(locateRepoRoot(), SHELL_DIR_NAME, STATE_DIR_NAME), seamActive: false };
	}
	if (!isAbsolute(seam)) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} is set but not an absolute path ` +
				`(${seam === "" ? "empty value" : seam}): refusing the run — ` +
				`no fallback toward the operational state root (§3.9, §5.5). ${RECOVERY}`,
		);
	}
	if (!existsSync(seam) || !statSync(seam).isDirectory()) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} is set but unusable (${seam} is missing or not a directory): ` +
				`refusing the run — no fallback toward the operational state root (§3.9, §5.5). ${RECOVERY}`,
		);
	}
	const target = physical(seam);
	const governedRoot = physical(locateRepoRoot());
	if (target === governedRoot || isStrictDescendant(target, governedRoot)) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} names a directory of the repository under governance ` +
				`(${seam} resolves to ${target}, inside ${governedRoot}): refusing the run — the state ` +
				`root holds this shell's own evidence, and a test-only seam inside the governed tree ` +
				`writes that surface into the tree it is meant to observe (§3.9, §5.5, §4.6). ` +
				`${OUT_OF_TREE_RECOVERY}`,
		);
	}
	if (isStrictDescendant(governedRoot, target)) {
		// The same boundary from the other side: a state root that CONTAINS the
		// governed repository puts the shell's own creation over a directory
		// the shell does not govern (§4.7).
		throw new Error(
			`[ghjig] ${STATE_SEAM} names a directory that CONTAINS the repository under governance ` +
				`(${seam} resolves to ${target}, which contains ${governedRoot}): refusing the run — ` +
				`creating a state root there writes over a directory this shell does not govern, and what ` +
				`it holds would reach wider than the tree the shell was pointed at ` +
				`(§3.9, §5.5, §4.7). ${OUT_OF_TREE_RECOVERY}`,
		);
	}
	return { root: seam, seamActive: true };
}

/**
 * Exclusive create, plus no-follow where the platform defines it. The
 * `?? 0` is load-bearing: an undefined flag would make the bitwise OR
 * `NaN` and fail every write. Exclusive is the rule itself — an entry
 * already at that path was not written by this function, and what it is
 * (a rule the repository already had, a link pointing elsewhere) is not
 * this function's to replace (§4.7).
 *
 * The two flags overlap by construction, and the overlap is deliberate:
 * an exclusive create already fails on a symbolic link at the path, so
 * removing the no-follow flag changes no outcome this suite can observe.
 * It is kept because it states the intent at the open — the sink in
 * `audit.ts` opens the same way — and because it is the flag that still
 * refuses the link if the exclusivity is ever relaxed to let this
 * function refresh what it wrote.
 */
const EXCLUSION_FLAGS =
	constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/**
 * Writes the exclusion, and only where it creates it.
 *
 * Anything already at that path stays: the target's choice wins, and a
 * link there is refused rather than followed, so the write can never land
 * on a file the shell does not own with content that excludes everything.
 */
function writeExclusion(root: string): void {
	let handle: number;
	try {
		handle = openSync(join(root, EXCLUSION_FILE_NAME), EXCLUSION_FLAGS, 0o600);
	} catch {
		// Already occupied: nothing to write, and nothing to report — an
		// exclusion the target already carries is the target's rule.
		return;
	}
	try {
		writeSync(handle, EXCLUSION_CONTENT);
	} finally {
		try {
			closeSync(handle);
		} catch {
			// A close that fails cannot un-write what was already written.
		}
	}
}

/**
 * Answers whether the components the shell itself names are the shell's own
 * to write through.
 *
 * §4.6's rule is that the path written is the path read. A link at
 * `<root>/.ghjig` or at the state directory sends the whole state root,
 * evidence and all, somewhere else, and every later read follows it there
 * without noticing. Such a link is therefore neither followed NOR removed:
 * the claim is DECLINED, the condition is reported with the remedy that
 * clears it, and the caller degrades. That is the shape the evidence sink
 * already uses against the same threat one component lower — lstat,
 * decline, warn, degrade open, the entry untouched — and the shape §4.7
 * states for an entry the target itself put there: skip, warn, name the
 * remedy, the target's choice wins. Nothing at the link and nothing it
 * points at is written, moved, or removed.
 *
 * Only those two components are examined, because they are the two this
 * module composes. Everything above them is the filesystem as the host
 * arranged it — a link there is the host's business, and this function
 * has no standing to touch it.
 *
 * False is returned iff a named component is a link. It is the caller's
 * signal that no state root stands at this path and none was created here.
 */
function claimNamedComponents(root: string): boolean {
	if (basename(root) !== STATE_DIR_NAME || basename(dirname(root)) !== SHELL_DIR_NAME) {
		return true;
	}
	for (const component of [dirname(root), root]) {
		let entry: ReturnType<typeof lstatSync>;
		try {
			entry = lstatSync(component);
		} catch {
			// Nothing there: the creation below makes the real directory.
			continue;
		}
		if (!entry.isSymbolicLink()) {
			continue;
		}
		console.warn(
			`[ghjig] ${component} is a symbolic link, so no state root was created and this run records ` +
				`nothing: the shell's state is created only where its path says it is, and a link there sends ` +
				`the evidence somewhere else while every later read follows it (§4.6). The link and what it ` +
				`points at are left exactly as they are (§4.7). Recovery: remove that link — the runtime ` +
				`creates the real directory itself on the next run — or point ${STATE_SEAM} at the directory ` +
				`state should live in.`,
		);
		return false;
	}
	return true;
}

/**
 * Creates the state root: the directory itself, and the exclusion that
 * keeps what lands in it out of version control. That is the whole of it —
 * the runtime's evidence sink creates its own file when it first appends.
 *
 * The explicit counterpart of `resolveStateRoot`: creation happens here
 * and nowhere else. What it creates is owner-only and excluded from
 * version control at creation (§4.7), so the shell never asks a
 * repository to carry a rule about the shell's own state. Idempotent, and
 * idempotent in the sense §4.7 gives it: a root that is already there is
 * left as it is found, and nothing this function did not write is
 * replaced.
 *
 * The answer says whether a state root stands at that path to be written
 * into: true where this call created it or found it already there, false
 * where a named component declined the claim — reported at the decline,
 * with the remedy. A declined claim and a create the filesystem refused
 * are different conditions and answer differently: the first returns
 * false, the second throws, so a caller can tell "there is no destination,
 * and touching it further would follow a link out of the tree" from "the
 * destination could not be made".
 */
export function ensureStateRoot(root: string): boolean {
	if (!claimNamedComponents(root)) {
		return false;
	}
	mkdirSync(root, { recursive: true, mode: STATE_MODE });
	writeExclusion(root);
	return true;
}
