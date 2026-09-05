/**
 * Dispatch executor — the delegate-agnostic bounded child (SPEC §4.9;
 * §3.10's outcome classes decided by the caller from this run shape).
 *
 * The delegate is an argv child (never a shell string) with cwd pinned to
 * the provisioned tree; the parent environment passes through with the
 * ONE state seam rebound — `GITJIG_TEST_STATE_ROOT=<scratch>/state`
 * (§5.5's disposable-root carve-out, pointed inside the scratch so the
 * delegate's state dies with the dispatch). Both streams are drained
 * UNRECORDED: no delegate stream byte is held anywhere it could later
 * cross a return or failure channel (§4.9's content-free channels; the
 * drain also keeps a flooding delegate off the kernel-buffer wedge).
 *
 * Two timers, one phase each (the measured race class this split
 * closes): the kill timer bounds the RUN and is cleared the moment the
 * child exits — an orphaned grandchild can hold the pipes open past the
 * child's death, and a kill timer still armed during the flush grace
 * would mark an in-bound run timed out; from exit the grace timer bounds
 * the FLUSH, deciding from what has arrived when "close" never comes
 * (§5.9's hung-dependency terms). A spawn failure surfaces as
 * `spawnFailed` so the caller can refuse on §3.10's delegate-absent
 * class rather than conflate it with a failed run. The child is spawned
 * detached and the bound kills its whole process group. Named residual
 * (§3.11): a double-forked, re-setsid'd grandchild survives any group
 * kill on this platform and inherits the passthrough environment —
 * named, not claimed closed.
 */
import { spawn } from "node:child_process";
import type { DispatchContext } from "./provision.ts";

/** Grace for stream flush after exit, when an orphan may hold the pipes. */
const STREAM_GRACE_MS = 2_000;

/** The run bound when the caller names none. */
export const DEFAULT_RUN_BOUND_MS = 120_000;

export interface DelegateRunOutcome {
	exitCode: number | null;
	timedOut: boolean;
	/** True iff the child never started — §3.10's delegate-absent class. */
	spawnFailed: boolean;
}

export function runDelegate(
	context: DispatchContext,
	argv: string[],
	options: { timeoutMs?: number } = {},
): Promise<DelegateRunOutcome> {
	return new Promise((resolve) => {
		if (argv.length === 0) {
			resolve({ exitCode: null, timedOut: false, spawnFailed: true });
			return;
		}
		let settled = false;
		let timedOut = false;
		const settle = (outcome: DelegateRunOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(outcome);
		};
		const child = spawn(argv[0], argv.slice(1), {
			cwd: context.treeDir,
			// Detached: the child leads its own process group, so the bound's
			// kill reaches delegate-spawned children too, not the child alone.
			detached: true,
			// Passthrough with the one seam rebound (§5.5): nothing else about
			// the parent environment is edited.
			env: { ...process.env, GITJIG_TEST_STATE_ROOT: context.stateDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let spawned = false;
		child.on("spawn", () => {
			spawned = true;
		});
		const killTimer = setTimeout(() => {
			timedOut = true;
			if (typeof child.pid === "number") {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			} else {
				child.kill("SIGKILL");
			}
		}, options.timeoutMs ?? DEFAULT_RUN_BOUND_MS);
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const decide = (code: number | null): void => {
			clearTimeout(killTimer);
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
			}
			settle({ exitCode: code, timedOut, spawnFailed: false });
		};
		child.on("error", () => {
			clearTimeout(killTimer);
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
			}
			// Delegate-absent iff the child never started: a post-spawn error
			// is a run that ran, decided as a failed run, never as absence.
			settle({ exitCode: null, timedOut, spawnFailed: !spawned });
		});
		// Drained, never recorded (§4.9): the streams flow and no byte is kept.
		child.stdout.resume();
		child.stderr.resume();
		child.on("exit", (code) => {
			// The bound is on the child's run, which has just ended — cleared
			// here, not in `decide`: an orphan can hold the pipes past the
			// bound, and a kill timer still armed during the flush grace would
			// mark an in-bound run timed out. From here the grace timer bounds
			// the flush alone.
			clearTimeout(killTimer);
			graceTimer = setTimeout(() => decide(code), STREAM_GRACE_MS);
		});
		child.on("close", (code) => decide(code));
	});
}
