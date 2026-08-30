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
 * Fail posture (§3.9, `repo-root-discovery` row): no `.pi/` ancestor →
 * degrade open with a warning and fall back to the structural root the
 * install layout implies (`.pi/extensions/ghjig/` → three levels up).
 * Absent means never installed; an actor cannot repair the installation
 * from inside a block.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function locateRepoRoot(): string {
	const moduleFile = realpathSync(fileURLToPath(import.meta.url));
	let current = dirname(moduleFile);
	for (;;) {
		const marker = join(current, ".pi");
		if (existsSync(marker) && statSync(marker).isDirectory()) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	const structuralRoot = resolve(dirname(moduleFile), "..", "..", "..");
	console.warn(
		`[ghjig] repo-root discovery failed: no .pi/ ancestor above ${moduleFile}; ` +
			`degrading open to the structural root ${structuralRoot} (§3.9)`,
	);
	return structuralRoot;
}
