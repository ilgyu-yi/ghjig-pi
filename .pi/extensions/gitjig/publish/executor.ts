/**
 * Egress publish executor — the bounded child under the Clean disposition
 * (SPEC §3.3; §3.10's five outcome classes; postures
 * `egress-publish-executor` and `egress-publish-outcome`).
 *
 * The child is `gh`, argv-composed (never a shell string), the body on
 * stdin (`--body-file -`, never an argv byte), cwd pinned to the
 * runtime's own repository root — `gh` resolves the target repository
 * from cwd, so an ambient cwd retargets the publication (§4.6) — the
 * environment passed through, and the run time-bounded.
 *
 * Admission is keyed on output validity alone (§3.10): success exactly
 * when the child exits 0 with a comment-URL shape as the whole of its
 * trimmed stdout. Exit status admits nothing by itself, and no presence
 * probe runs. A zero-exit run without that shape is post-send ambiguity —
 * the send left the process and no valid outcome can be established — and
 * lands the `outcome-unverified` terminal outcome, claiming neither
 * publication nor withholding (§5.6). A spawn failure, a non-zero exit,
 * and an exceeded bound each refuse admission with a fixed content-free
 * cause. No child stream bytes ever enter a returned cause: the streams
 * can echo request bodies (§3.3's Clean clause), so stderr is drained
 * unrecorded and stdout is consulted only by the anchored shape test —
 * the one surface a validated success URL may cross on.
 *
 * The settle logic never waits on stream EOF alone: an orphaned
 * grandchild can hold the pipes open past the child's death (the hanging
 * shape), so the exit event starts a short flush grace and the outcome is
 * decided from what has arrived — a wedge becomes a bounded refusal,
 * never a wedged session (§5.9's hung-dependency terms).
 */
import { spawn } from "node:child_process";

/** The structured publish target — the actor names it, nothing infers it (§3.3). */
export interface PublishDestination {
	kind: "issue-comment" | "pr-comment";
	number: number;
}

/** Structural admission for a destination that arrived untyped. */
export function isPublishDestination(value: unknown): value is PublishDestination {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const { kind, number } = value as { kind?: unknown; number?: unknown };
	return (
		(kind === "issue-comment" || kind === "pr-comment") &&
		typeof number === "number" &&
		Number.isSafeInteger(number) &&
		number > 0
	);
}

/** The destination union's pinned argv spelling (§3.3's measurement domain). */
export function ghCommentArgv(destination: PublishDestination): string[] {
	const surface = destination.kind === "issue-comment" ? "issue" : "pr";
	return [surface, "comment", String(destination.number), "--body-file", "-"];
}

/** The child's bound — well under any caller's own backstop (§3.3). */
export const CHILD_TIMEOUT_MS = 10_000;

/** Grace for stream flush after exit, when an orphan may hold the pipes. */
const STREAM_GRACE_MS = 2_000;

/** Output validity: one comment-URL, the whole of the trimmed stdout (§3.10). */
const COMMENT_URL_SHAPE = /^https:\/\/[^\s]+#issuecomment-\d+$/;

export type PublishChildOutcome =
	| { outcome: "published"; url: string }
	| { outcome: "outcome-unverified" }
	| { outcome: "refused"; cause: string };

/**
 * Run one bounded publish child and admit its outcome per the header.
 * Every returned `cause` is a fixed composition over numbers and signal
 * names — never a stream byte, never an error message.
 */
export function runPublishChild(argv: string[], body: string, repoRoot: string): Promise<PublishChildOutcome> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let stdout = "";
		const child = spawn("gh", argv, {
			cwd: repoRoot,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const settle = (outcome: PublishChildOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			// Release this side of the pipes: an orphan holding the far ends
			// must not hold this process open after the outcome is decided.
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			resolve(outcome);
		};
		const killTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, CHILD_TIMEOUT_MS);
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const decide = (code: number | null, signal: string | null): void => {
			clearTimeout(killTimer);
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
			}
			if (timedOut) {
				settle({
					outcome: "refused",
					cause: `the publish child exceeded its ${CHILD_TIMEOUT_MS} ms bound and was terminated; the send is not admitted`,
				});
			} else if (code === 0) {
				const line = stdout.trim();
				if (COMMENT_URL_SHAPE.test(line)) {
					settle({ outcome: "published", url: line });
				} else {
					settle({ outcome: "outcome-unverified" });
				}
			} else {
				settle({
					outcome: "refused",
					cause: `the delegated run reported failure (${code !== null ? `exit status ${code}` : `signal ${signal ?? "unknown"}`})`,
				});
			}
		};
		child.on("error", () => {
			clearTimeout(killTimer);
			settle({
				outcome: "refused",
				cause: "the publish delegate could not be run from this session's environment; the send never started",
			});
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		// Drained, never recorded (§3.3's stream exclusion).
		child.stderr.resume();
		// A child that never reads its stdin surfaces here as EPIPE; the
		// outcome is decided by the exit path, not the write.
		child.stdin.on("error", () => {});
		child.stdin.end(body);
		child.on("exit", (code, signal) => {
			// The bound is on the child's run, which has just ended — clear it
			// here, not in `decide`: an orphan can hold the pipes past the
			// bound, and a kill timer still armed during the flush grace would
			// mark an in-bound run timed out. A child that never exits still
			// trips the kill timer. From here the grace timer bounds the flush.
			clearTimeout(killTimer);
			// Streams may still be flushing; "close" decides as soon as they
			// end, and the grace decides when an orphan never lets them end.
			graceTimer = setTimeout(() => decide(code, signal), STREAM_GRACE_MS);
		});
		child.on("close", (code, signal) => decide(code, signal));
	});
}
