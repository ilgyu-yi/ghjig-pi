/**
 * State-root resolution — RESOLUTION ONLY (SPEC §5.5, §4.6).
 *
 * With no seam set, the operational root `<repo>/.ghjig/state/` is
 * computed and returned without creating anything: operational-root
 * creation lands with the first operational writer (§6.1
 * build-as-consumed), not here.
 *
 * The single override seam `GHJIG_TEST_STATE_ROOT` is the only
 * environment variable the runtime reads anywhere; the name marks it
 * test-only, and an active seam is reported (`seamActive: true`) so the
 * entry can announce it (§5.9).
 *
 * Fail posture (§3.9, `seam-target` row): a seam that is set but
 * unusable — relative, missing, or not a directory — REFUSES the run.
 * Falling back would write the operational evidence surface from a test
 * context, exactly what §5.5 forbids.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { locateRepoRoot } from "./locate.ts";

/** The single test-only override seam — the runtime's only env read. */
export const STATE_SEAM = "GHJIG_TEST_STATE_ROOT";

export interface StateRootResolution {
	/** Absolute path of the state root; nothing under it is created here. */
	root: string;
	/** True iff the test-only seam supplied the root. */
	seamActive: boolean;
}

export function resolveStateRoot(): StateRootResolution {
	const seam = process.env[STATE_SEAM];
	if (seam === undefined || seam === "") {
		return { root: join(locateRepoRoot(), ".ghjig", "state"), seamActive: false };
	}
	if (!isAbsolute(seam)) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} is set but relative (${seam}): refusing the run — ` +
				`no fallback toward the operational state root (§3.9, §5.5)`,
		);
	}
	if (!existsSync(seam) || !statSync(seam).isDirectory()) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} is set but unusable (${seam} is missing or not a directory): ` +
				`refusing the run — no fallback toward the operational state root (§3.9, §5.5)`,
		);
	}
	return { root: seam, seamActive: true };
}
