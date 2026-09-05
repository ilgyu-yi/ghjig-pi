/**
 * The /review command — an operator-initiated call site of the ONE
 * dispatcher (SPEC §4.9 "one home, many call sites"; §4.8 rung 1: the
 * blind compare and the caller-derived round count are acts that must not
 * be contingent on a model's cooperation).
 *
 * Argument string: `[timeoutMs=<n>] <expectedRef> <delegateArgv…>`,
 * whitespace-split, the bound optional and recognized in first position only
 * (issue #94 — a positional grammar cannot tell a bound token from a delegate
 * argv element anywhere else). The
 * handler resolves no ref itself: `expectedRef` crosses to the dispatcher,
 * which resolves it exactly once at provision and holds the hash (§4.9
 * pin-at-provision). What this command returns to the session is its own
 * entry — the disposition, the compare's VALIDITY token
 * (`confirmed`/`invalid`), and the admitted summary — never an operand
 * (§1.6 via §4.9's content-free return channels). The dispatch acts land
 * their `category:"dispatch"` audit records inside the dispatcher itself;
 * this module mints no record and no second channel.
 *
 * No reviewer instructions, no verdict grammar, and no role prompt ride
 * this surface: the delegate's conduct is carried by its own argv and the
 * provisioned tree — the instruct half of the worked case is §4.8's
 * enumerated residual, never this registration's carry.
 *
 * The handler confines itself to channels the print path wires (§4.4):
 * `pi.appendEntry`, `pi.sendMessage`, and `ctx.waitForIdle` — the last is
 * bound by print mode itself. After the entry is appended the handler
 * triggers ONE empty custom-message turn and awaits idle, because the
 * substrate writes a NEW session's entries to disk only once an assistant
 * message exists (`SessionManager._persist` buffers until then): without
 * the turn, a command-only headless run would leave no durable record of
 * the dispatch at all.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDispatch } from "../dispatch/index.ts";

/**
 * The fixed dispatch brief (§1.5's dispatch-facts carrier): fixed text by
 * construction, so no caller-held operand can ride it. The facts a review
 * needs stand in the provisioned tree the delegate works in.
 */
const REVIEW_BRIEF =
	"Operator-initiated review dispatch (/review call site). Review the provisioned tree at its pinned " +
	"head and report through the bounded return slot (../return.json) alone; nothing else crosses back.";

/** Fixed content-free refusal for an inadmissible argument string. */
const REFUSE_ARGS =
	"review refused: the argument string must be `[timeoutMs=<n>] <expectedRef> <delegateArgv…>` — at " +
	"least two whitespace-split tokens after the optional bound; nothing was dispatched";

/**
 * An inadmissible bound on the optional leading token. Refused rather than
 * dropped: a caller who spelled a bound and got the default silently ran under
 * one they did not ask for. The token is recognized only in first position, so
 * a delegate argv element of the same shape is never eaten (issue #94).
 */
const REFUSE_BOUND =
	"review refused: the leading timeoutMs= token is not an admissible positive number of " +
	"milliseconds; nothing was dispatched";

export function registerReviewCommand(pi: ExtensionAPI, repoRoot: string, stateRoot: string): void {
	pi.registerCommand("review", {
		description:
			"Dispatch a review delegate into an isolated clone pinned at a once-resolved expected head: " +
			"/review [timeoutMs=<n>] <expectedRef> <delegateArgv…>. Only the bounded return crosses back, and " +
			"the compare surfaces as validity alone. The delegate runs in the caller's trust domain and " +
			"inherits its environment, credentials included: remote reach through inherited credentials is " +
			"not confined.",
		handler: async (args: string, ctx) => {
			const tokens = args.split(/\s+/).filter((token) => token !== "");
			// The bound is read from FIRST POSITION ONLY. A positional grammar
			// cannot tell a bound token from a delegate argv element anywhere else,
			// and eating one would change what the delegate runs.
			let timeoutMs: number | undefined;
			let boundRefused = false;
			if (tokens.length > 0 && tokens[0].startsWith("timeoutMs=")) {
				const raw = Number(tokens[0].slice("timeoutMs=".length));
				if (!Number.isFinite(raw) || raw <= 0) {
					boundRefused = true;
				} else {
					timeoutMs = raw;
				}
				tokens.shift();
			}
			if (boundRefused) {
				pi.appendEntry("gitjig-review", { disposition: "refused", cause: REFUSE_BOUND });
			} else if (tokens.length < 2) {
				pi.appendEntry("gitjig-review", { disposition: "refused", cause: REFUSE_ARGS });
			} else {
				const [expectedRef, ...delegateArgv] = tokens;
				const outcome = await runDispatch({
					callerRepoRoot: repoRoot,
					stateRoot,
					brief: REVIEW_BRIEF,
					delegateArgv,
					expectedRef,
					timeoutMs,
				});
				if (outcome.disposition === "refused") {
					// The cause is one of the dispatcher's fixed content-free
					// literals — passed through, never rephrased (§4.9).
					pi.appendEntry("gitjig-review", { disposition: "refused", cause: outcome.cause });
				} else {
					pi.appendEntry("gitjig-review", {
						disposition: "admitted",
						ok: outcome.ok,
						compare: outcome.compare,
						summary: outcome.summary,
					});
				}
			}
			// The durability turn (header): empty fixed content, so nothing
			// caller-held can ride it; `triggerTurn` makes an assistant message
			// land, which is what flushes the buffered entries to disk.
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [] }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}
