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
 * UNMODELLED residual (§3.11 — a gate enumerates in place the vectors it
 * deliberately does not model, so a residual reads as a decision rather
 * than an oversight): the seam target is measured with two probes of one
 * path, `existsSync` then `statSync`. A target that stops being
 * measurable BETWEEN them makes the second probe throw a raw filesystem
 * error, and `resolveStateRoot` is called at extension-factory scope, so
 * that error escapes the same way a refusal does — but carrying neither
 * this module's refusal text nor its `RECOVERY` string, which is the
 * remediation every arm here otherwise owes. Refusing is what the
 * fail-closed `seam-target` row prescribes, so the fail direction is
 * unaffected; what is lost is the recovery the operator is told. This is
 * stated as unmodelled, not handled: no arm covers it, nothing here
 * narrows it, and the trigger is an inter-probe race no honest check can
 * stage (§3.12).
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

/** The live recovery every refusal arm names (§3.11). */
const RECOVERY =
	`Recovery: unset ${STATE_SEAM} to use the operational state root, ` +
	`or point it at an existing absolute directory.`;

export function resolveStateRoot(): StateRootResolution {
	const seam = process.env[STATE_SEAM];
	if (seam === undefined) {
		return { root: join(locateRepoRoot(), ".ghjig", "state"), seamActive: false };
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
	return { root: seam, seamActive: true };
}
