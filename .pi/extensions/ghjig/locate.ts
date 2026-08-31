/**
 * Repository-root self-location (SPEC §4.6).
 *
 * Resolution starts from THIS module's own installed path
 * (`import.meta.url`, realpath-resolved so a symlinked install — e.g. a
 * test fixture linking the repository tree — still resolves to the real
 * tree) and walks upward to the nearest ancestor containing a `.pi/`
 * directory. Never reads an environment variable, never consults the
 * process working directory: the entry point resolves its own argument
 * against this module's directory, so a relative argument yields the same
 * answer from every working directory instead of inheriting one.
 *
 * The walk is bounded below by the structural root the install layout
 * implies (`.pi/extensions/ghjig/` → three levels up). A `.pi/` directory
 * strictly BELOW that root cannot be the repository root — a repository
 * binds at its root only, never recursively into subprojects (§4.7) — so
 * such a candidate is rejected with a warning naming it, and the walk
 * continues upward. Without the bound a single empty, git-invisible
 * `mkdir .pi/extensions/ghjig/.pi` would silently relocate the evidence
 * sink into the install tree. The upper bound is unchanged: the walk still
 * terminates at the filesystem root and a legitimately higher `.pi/`
 * ancestor is still accepted.
 *
 * "Below" is decided component-wise, never by string prefix: a directory
 * whose name merely begins with two dots is a genuine descendant, and a
 * sibling that merely shares the root's spelling is not one. The same
 * predicate answers the seam exclusion (§5.5), so the two call sites ask
 * one rule rather than two implementations of it (§3.11).
 *
 * Fail posture (§3.9, `repo-root-discovery` row): no admissible `.pi/`
 * ancestor → degrade open with a warning and fall back to the structural
 * root. Absent means never installed; an actor cannot repair the
 * installation from inside a block. Every filesystem probe returns rather
 * than throws for the same reason: a throw out of the extension factory is
 * turned into a non-zero exit by the substrate, which is the fail-closed
 * outcome this row denies.
 */
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { posture } from "./postures.ts";

/** This module's own directory — the anchor every relative argument resolves against. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * True iff `candidate` sits strictly below `ancestor` in the tree.
 *
 * Both arguments are compared as paths, not as strings: the relative step
 * from `ancestor` to `candidate` is read component-wise, so only a leading
 * component that IS `..` means "upward". A component that merely begins
 * with two dots (`..foo`) is an ordinary directory name, and a sibling
 * (`<ancestor>-other`) is reached by an upward step and is therefore not a
 * descendant — the false-block a string prefix would ship.
 */
export function isStrictDescendant(candidate: string, ancestor: string): boolean {
	const rel = relative(ancestor, candidate);
	if (rel === "" || isAbsolute(rel)) {
		return false;
	}
	return rel.split(sep)[0] !== "..";
}

/**
 * A path as the filesystem resolves it, resolved as far as it exists — the
 * one normaliser the predicate above takes its operands through.
 *
 * The invariant: both operands of a containment test are expressed in one
 * coordinate system. A helper that fell back to the SPELLING when a path
 * does not fully resolve would compare a spelling against a resolved root —
 * and where a temporary or home directory is reached through a link, those
 * disagree while naming the same place, so containment would answer
 * "outside" for a path that is inside. Resolving the deepest existing
 * ancestor and re-appending the rest keeps the coordinates the same whether
 * or not the last components are there: an operand can always be a
 * directory that has not been created yet, or one removed under a live
 * session.
 *
 * It lives beside `isStrictDescendant` because a second normaliser with
 * different semantics is a second answer to the containment question —
 * the predicate and the coordinate system its operands are read in are one
 * rule with one home (§3.11).
 */
export function physical(path: string): string {
	const pending: string[] = [];
	let current = resolve(path);
	for (;;) {
		try {
			const resolved = realpathSync(current);
			return pending.length === 0 ? resolved : join(resolved, ...pending);
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				// Nothing on this path resolves: the spelling is the only answer
				// there is, and answering is what this helper owes its caller.
				return resolve(path);
			}
			pending.unshift(basename(current));
			current = parent;
		}
	}
}

/** True iff `path` is a directory; any probe failure answers "no", never throws. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		// A missing entry, a dangling or looping link, a non-directory parent:
		// every one of them means "no admissible marker here", which is an
		// answer, not an error (§3.9 `repo-root-discovery` is fail-open).
		return false;
	}
}

/**
 * The resolution proper, parameterised on the installed module path so the
 * admissibility bound is exercisable without writing into a real tree.
 *
 * A relative `moduleFile` is resolved against this module's own directory,
 * which is what keeps the process working directory out of the answer for
 * every entry point rather than only for the default one.
 */
export function locateRepoRootFrom(moduleFile: string): string {
	const installedFile = resolve(MODULE_DIR, moduleFile);
	const structuralRoot = resolve(dirname(installedFile), "..", "..", "..");
	let current = dirname(installedFile);
	for (;;) {
		if (isDirectory(join(current, ".pi"))) {
			if (!isStrictDescendant(current, structuralRoot)) {
				return current;
			}
			console.warn(
				`[ghjig] ignoring the .pi/ directory at ${current}: it sits below the install root ` +
					`${structuralRoot}, so it cannot be the repository root — a repository binds at ` +
					`its root only, never recursively into subprojects (§4.7)`,
			);
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	console.warn(
		`[ghjig] repo-root discovery failed: no admissible .pi/ ancestor above ${installedFile}; ` +
			`degrading open to the structural root ${structuralRoot} (§3.9) — ` +
			`${posture("repo-root-discovery").degradationSignal}`,
	);
	return structuralRoot;
}

export function locateRepoRoot(): string {
	const self = fileURLToPath(import.meta.url);
	let installed = self;
	try {
		// A symlinked install must resolve to the real tree; when the link
		// cannot be resolved at all the lexical path is still an answer, and
		// answering is what this module owes its caller (§3.9).
		installed = realpathSync(self);
	} catch {
		installed = self;
	}
	return locateRepoRootFrom(installed);
}
