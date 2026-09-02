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
 * unusable — empty, relative, missing, or not a directory — REFUSES the
 * run. Falling back would write the operational evidence surface from a
 * test context, exactly what §5.5 forbids. "Set" is decided on presence
 * alone, so an empty value is present-and-unmeasurable and refuses like
 * any other unusable value; only an UNSET seam takes the fail-open arm
 * and returns the operational root with `seamActive: false`.
 *
 * Every refusal names its own live recovery (§3.11), because the
 * surrounding substrate otherwise offers the operator only a total
 * extension-layer disarm.
 *
 * The seam target is measured with ONE probe. Measured with two —
 * `existsSync` then `statSync` — a target that stopped being measurable
 * between them made the second probe throw a raw filesystem error, and
 * `resolveStateRoot` is called at extension-factory scope, so that error
 * escaped the same way a refusal does but carrying neither this module's
 * refusal text nor its `RECOVERY` string, the remediation every arm here
 * otherwise owes. The two probes answered the same question and produced
 * the same refusal, so collapsing them closes the window rather than
 * enumerating it: missing, not a directory, and refused are one answer,
 * and every one of them refuses with the recovery attached.
 */
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { locateRepoRoot } from "./locate.ts";
import { quoted } from "./quote.ts";

/** The single test-only override seam — the runtime's only env read. */
export const STATE_SEAM = "GHJIG_TEST_STATE_ROOT";

export interface StateRootResolution {
	/** Absolute path of the state root; nothing under it is created here. */
	root: string;
	/** True iff the test-only seam supplied the root. */
	seamActive: boolean;
}

/** The live recovery every refusal arm names (§3.11). */
const RECOVERY =
	`Recovery: unset ${STATE_SEAM} to use the operational state root, ` +
	`or point it at an existing absolute directory.`;

/**
 * True iff `path` is a directory. One probe, one answer: a refused probe
 * is not a directory, and it is not a throw either — the raw error would
 * escape factory scope without this module's refusal text or `RECOVERY`.
 */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function resolveStateRoot(): StateRootResolution {
	const seam = process.env[STATE_SEAM];
	if (seam === undefined) {
		return { root: join(locateRepoRoot(), ".ghjig", "state"), seamActive: false };
	}
	if (!isAbsolute(seam)) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} is set but not an absolute path ` +
				`(${seam === "" ? "empty value" : quoted(seam)}): refusing the run — ` +
				`no fallback toward the operational state root (§3.9, §5.5). ${RECOVERY}`,
		);
	}
	if (!isDirectory(seam)) {
		throw new Error(
			`[ghjig] ${STATE_SEAM} is set but unusable (${quoted(seam)} is not a directory this account can ` +
				`measure — missing, not a directory, or refused): ` +
				`refusing the run — no fallback toward the operational state root (§3.9, §5.5). ${RECOVERY}`,
		);
	}
	return { root: seam, seamActive: true };
}
