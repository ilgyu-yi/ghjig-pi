/**
 * Dispatch provision — the isolated execution context, pinned at provision
 * (SPEC §4.9 pin-at-provision; §1.5 tree isolation; §1.6).
 *
 * Provision resolves the expected ref EXACTLY ONCE, in the caller's
 * repository — `expectedRef` when given, the caller's HEAD otherwise —
 * and holds the hash. The isolated tree is a `git clone --no-hardlinks`
 * of the caller repository into a `mkdtempSync` scratch, detached at the
 * held hash, so the provisioned tree equals the held operand by
 * construction and nothing at run time can re-resolve the ref (§4.9).
 * Scratch layout: `tree/` (the delegate's cwd and whole writable world),
 * `brief.md` (the dispatched brief's bytes, §1.5's dispatch-facts
 * carrier), `state/` (the delegate's rebound state seam, §5.5), and the
 * `return.json` slot — the sole crossing, reached by the delegate as
 * `../return.json` from its tree cwd, layout-derived with no second
 * locator surface.
 *
 * A worktree (`git worktree add`) is REJECTED as the isolation form: a
 * worktree shares the caller's object and ref store, so a delegate
 * commit would land in the caller's `.git` — the clone is what makes the
 * delegate's every write invisible to the caller (§1.5), once the two
 * routes the clone itself plants back are severed at provision: the
 * origin remote is removed, and `.git/logs` is deleted whole because the
 * reflog records `clone: from <caller-path>`, a mineable address for a
 * by-path push. What remains is the trust-domain residual — a same-uid
 * delegate can still discover the caller path from inherited environment
 * or a filesystem scan; the trace provision itself plants is removed.
 * An expected ref
 * naming no object in the caller repository fails LOUD with a fixed
 * content-free cause, never a silently-provisioned tree (§3.9): an
 * unresolvable expected head is ambiguity, and the thrown cause names no
 * caller-held operand (§4.9's content-free channels).
 *
 * Named residual (§3.11): a dispatcher killed uncleanly orphans its
 * scratch. The OS temp root is the boundary that contains the orphan; no
 * TTL reap runs — an unfired contingency earns no code.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The provisioned context: path-pinned layout plus the held operand. */
export interface DispatchContext {
	scratchRoot: string;
	treeDir: string;
	briefPath: string;
	returnPath: string;
	stateDir: string;
	/** The once-resolved commit hash the tree is detached at (§4.9). */
	heldHash: string;
}

/** Fixed loud-refusal causes — content-free, naming no operand (§3.9);
 * exported so the composed pipeline can pass a known cause through. */
export const PROVISION_REFUSAL_CAUSES = {
	unresolvable:
		"dispatch provision refused: the expected ref resolves to no commit in the caller repository — " +
		"an unresolvable expected head is ambiguity, never a provisioned tree (SPEC §4.9, §3.9)",
	clone:
		"dispatch provision refused: the isolated tree could not be cloned and detached at the held hash (SPEC §4.9, §1.5)",
} as const;

export function provisionDispatchContext(
	callerRepoRoot: string,
	options: { brief: string; expectedRef?: string },
): DispatchContext {
	// Resolved once, here, in the caller's repository; the hash is held and
	// every later act binds to it (§4.9 pin-at-provision).
	let heldHash: string;
	try {
		heldHash = execFileSync(
			"git",
			[
				"-C",
				callerRepoRoot,
				"rev-parse",
				"--verify",
				"--quiet",
				"--end-of-options",
				`${options.expectedRef ?? "HEAD"}^{commit}`,
			],
			{ encoding: "utf8" },
		).trim();
	} catch {
		throw new Error(PROVISION_REFUSAL_CAUSES.unresolvable);
	}
	if (!/^[0-9a-f]{40}$/.test(heldHash)) {
		throw new Error(PROVISION_REFUSAL_CAUSES.unresolvable);
	}
	// mkdtemp's exclusive creation is the isolation floor two racing
	// dispatches stand on (§1.5).
	const scratchRoot = mkdtempSync(join(tmpdir(), "gitjig-dispatch-"));
	const treeDir = join(scratchRoot, "tree");
	try {
		execFileSync("git", ["clone", "-q", "--no-hardlinks", callerRepoRoot, treeDir], { encoding: "utf8" });
		execFileSync("git", ["-C", treeDir, "checkout", "-q", "--detach", heldHash], { encoding: "utf8" });
		// The clone's origin remote is a route back to the caller repository —
		// push and fetch both — and is severed here (§1.5).
		execFileSync("git", ["-C", treeDir, "remote", "remove", "origin"], { encoding: "utf8" });
		// The clone's reflog is the second planted route back: `.git/logs`
		// records `clone: from <caller-path>`, and a by-path push needs no
		// remote. Removed whole (§1.5).
		rmSync(join(treeDir, ".git", "logs"), { recursive: true, force: true });
		writeFileSync(join(scratchRoot, "brief.md"), options.brief);
		mkdirSync(join(scratchRoot, "state"));
	} catch {
		// A half-provisioned scratch is removed before the loud refusal: the
		// caller holds no context to clean (§3.9).
		rmSync(scratchRoot, { recursive: true, force: true });
		throw new Error(PROVISION_REFUSAL_CAUSES.clone);
	}
	return {
		scratchRoot,
		treeDir,
		briefPath: join(scratchRoot, "brief.md"),
		returnPath: join(scratchRoot, "return.json"),
		stateDir: join(scratchRoot, "state"),
		heldHash,
	};
}

/** Removes the scratch whole — the dispatch leaves nothing behind (§1.5). */
export function cleanupDispatchContext(context: DispatchContext): void {
	rmSync(context.scratchRoot, { recursive: true, force: true });
}
