/**
 * Repository-root self-location (SPEC §4.6).
 *
 * Resolution starts from THIS module's own installed path
 * (`import.meta.url`, realpath-resolved so a symlinked install — e.g. a
 * test fixture linking the repository tree — still resolves to the real
 * tree) and walks upward to the nearest ancestor containing a `.pi/`
 * directory. Never reads an environment variable, never consults the
 * process working directory.
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
 * Fail posture (§3.9, `repo-root-discovery` row): no admissible `.pi/`
 * ancestor → degrade open with a warning and fall back to the structural
 * root. Absent means never installed; an actor cannot repair the
 * installation from inside a block. Every filesystem probe on the walk
 * answers rather than throws for the same reason: this resolution runs
 * inside the extension factory, where an escaping throw aborts extension
 * load — the fail-closed outcome that posture row denies.
 *
 * A relative `moduleFile` is the one input the resolution refuses. It has
 * no anchor that is not the process working directory, and the working
 * directory is exactly what §4.6 forbids on the hot path — resolving it
 * would answer differently per directory. The refusal is an argument
 * precondition, not a `repo-root-discovery` failure: the shipped entry
 * point below always passes an absolute path, so nothing reachable from
 * the extension factory can raise it.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { quoted } from "./quote.ts";

/**
 * True iff `candidate` sits strictly below `ancestor` in the tree.
 *
 * Decided component-wise: `relative()` expresses "outside the ancestor"
 * as a leading `..` PATH COMPONENT, and a textual prefix test cannot tell
 * that component from an ordinary directory merely named `..z`. §4.6
 * requires path-prefix collisions never mis-scope in either direction,
 * and here the wrong answer adopts a subproject `.pi/` as the repository
 * root and relocates the evidence sink into the install tree (§4.7).
 */
function isStrictDescendant(candidate: string, ancestor: string): boolean {
	const rel = relative(ancestor, candidate);
	return rel !== "" && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * True iff `path` is a directory. A refused probe is not a marker and is
 * never a throw: `existsSync` already swallows the refusals a check can
 * stage, so an unguarded `statSync` behind it throws only when the state
 * changes BETWEEN the two probes — a race no honest check can construct
 * (§3.12), and the one path by which a fail-closed abort escapes an
 * open-posture walk. One probe, one answer.
 */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The resolution proper, parameterised on the installed module path so the
 * admissibility bound is exercisable without writing into a real tree.
 */
export function locateRepoRootFrom(moduleFile: string): string {
	if (!isAbsolute(moduleFile)) {
		throw new Error(
			`[ghjig] repo-root discovery cannot anchor the relative module path ${quoted(moduleFile)}: ` +
				`resolution never consults the process working directory (§4.6), and a relative path ` +
				`has no other anchor — answering would give a different repository root per directory. ` +
				`Recovery: pass the installed module's absolute path ` +
				`(realpathSync(fileURLToPath(import.meta.url))), or call locateRepoRoot().`,
		);
	}
	const structuralRoot = resolve(dirname(moduleFile), "..", "..", "..");
	let current = dirname(moduleFile);
	for (;;) {
		const marker = join(current, ".pi");
		if (isDirectory(marker)) {
			if (!isStrictDescendant(current, structuralRoot)) {
				return current;
			}
			console.warn(
				`[ghjig] ignoring the .pi/ directory at ${quoted(current)}: it sits below the install root ` +
					`${quoted(structuralRoot)}, so it cannot be the repository root — a repository binds at ` +
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
		`[ghjig] repo-root discovery failed: no admissible .pi/ ancestor above ${quoted(moduleFile)}; ` +
			`degrading open to the structural root ${quoted(structuralRoot)} (§3.9)`,
	);
	return structuralRoot;
}

export function locateRepoRoot(): string {
	// `import.meta.url` is always absolute, so the walk below never refuses.
	// The realpath resolution is the remaining probe that can throw, and it
	// runs at extension load: degrade open to the unresolved module path and
	// say so, rather than abort the load (§3.9 `repo-root-discovery`, §5.2 —
	// fail open with a surfaced signal).
	const self = fileURLToPath(import.meta.url);
	let installed = self;
	try {
		installed = realpathSync(self);
	} catch (error) {
		// Escaped at the extraction (issue #47): a filesystem error message
		// embeds the failing path verbatim, so the cause is interpolated
		// through `quoted` exactly as the path itself is.
		console.warn(
			`[ghjig] could not resolve the installed module path ${quoted(self)} through its links; ` +
				`locating from the unresolved path instead, which mislocates the repository root if ` +
				`the install is a symlink (§3.9). Cause: ${quoted(error instanceof Error ? error.message : String(error))}. ` +
				`Recovery: restore read access to every directory on that path, then start a new session.`,
		);
	}
	return locateRepoRootFrom(installed);
}
