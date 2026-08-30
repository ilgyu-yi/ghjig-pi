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
 * installation from inside a block.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** True iff `candidate` sits strictly below `ancestor` in the tree. */
function isStrictDescendant(candidate: string, ancestor: string): boolean {
	const rel = relative(ancestor, candidate);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The resolution proper, parameterised on the installed module path so the
 * admissibility bound is exercisable without writing into a real tree.
 */
export function locateRepoRootFrom(moduleFile: string): string {
	const structuralRoot = resolve(dirname(moduleFile), "..", "..", "..");
	let current = dirname(moduleFile);
	for (;;) {
		const marker = join(current, ".pi");
		if (existsSync(marker) && statSync(marker).isDirectory()) {
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
		`[ghjig] repo-root discovery failed: no admissible .pi/ ancestor above ${moduleFile}; ` +
			`degrading open to the structural root ${structuralRoot} (§3.9)`,
	);
	return structuralRoot;
}

export function locateRepoRoot(): string {
	return locateRepoRootFrom(realpathSync(fileURLToPath(import.meta.url)));
}
