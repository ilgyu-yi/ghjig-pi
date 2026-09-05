/**
 * The /ship command — the merge boundary's caller-side composition (SPEC
 * §4.8 rung 1, worked case `ship`; a call site of the predicates the §3.3
 * `merge-review` and `ac-closeout` rows own, both `procedural today` —
 * evaluated over facts the caller supplies, deciding nothing the platform
 * holds and adding no enforcement).
 *
 * No merge is performed and no network is reached. Three offline
 * undecidables are named in the registered description, which is the
 * command's registration record: the platform-held review verdict, the
 * platform-held AC state, and the merge act itself.
 *
 * Fact grammar — whitespace-split `key=value` tokens on the argument
 * string:
 *
 *   `verdict-head=<hash>` — the head the caller read the approving review
 *     verdict pinned at, off the platform surface;
 *   `ac=closed` — the caller's assertion that AC closure is discharged on
 *     the platform surface.
 *
 * The local head is resolved EXACTLY once per invocation, by one git child
 * under the scrubbed env (`withoutRepoLocatingGitEnv` — an inherited
 * GIT_DIR would retarget the read at another repository, §1.5), and
 * `composition` is `satisfied` iff the supplied verdict head byte-equals
 * that once-resolved head AND the AC-closure fact is asserted; any absent,
 * unequal, or unresolvable input composes `unsatisfied`. The session entry
 * carries per-check tokens alone — never the resolved head and never the
 * supplied one: an expected head in an injectable context makes every
 * later blind compare at that head echoable (§1.6 via §4.9's content-free
 * channels).
 *
 * The handler confines itself to channels the print path wires (§4.4):
 * `pi.appendEntry`, `pi.sendMessage`, and `ctx.waitForIdle` — the last is
 * bound by print mode itself. After the entry is appended the handler
 * triggers ONE empty custom-message turn and awaits idle, because the
 * substrate writes a NEW session's entries to disk only once an assistant
 * message exists (`SessionManager._persist` buffers until then): without
 * the turn, a command-only headless run would leave no durable record of
 * the composition at all.
 */
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";

export function registerShipCommand(pi: ExtensionAPI, repoRoot: string): void {
	pi.registerCommand("ship", {
		description:
			"Compose the merge-boundary caller-side checks over caller-supplied facts: " +
			"/ship verdict-head=<hash> ac=closed. The supplied verdict head must byte-equal the " +
			"once-resolved local head, and AC closure must be asserted. It cannot decide offline the " +
			"platform-held review verdict or the platform-held AC state, and it never performs the merge " +
			"act — all three stay on the platform surface.",
		handler: async (args: string, ctx) => {
			const facts = new Map<string, string>();
			for (const token of args.split(/\s+/)) {
				const eq = token.indexOf("=");
				if (eq > 0) {
					facts.set(token.slice(0, eq), token.slice(eq + 1));
				}
			}
			// The one local resolution of this invocation (header): its result
			// feeds the byte-equality alone and enters no output surface.
			let localHead: string | undefined;
			try {
				const resolved = execFileSync(
					"git",
					["-C", repoRoot, "rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
					{ encoding: "utf8", env: withoutRepoLocatingGitEnv(process.env) },
				).trim();
				if (/^[0-9a-f]{40}$/.test(resolved)) {
					localHead = resolved;
				}
			} catch {
				// An unresolvable local head is an unsatisfied input, composed
				// below — never a throw out of the handler and never a named
				// operand (§4.9's content-free channels).
			}
			const verdictHead = facts.get("verdict-head");
			const verdictPinned =
				localHead !== undefined && verdictHead !== undefined && verdictHead === localHead
					? "confirmed"
					: "unsatisfied";
			const acClosure = facts.get("ac") === "closed" ? "asserted" : "unsatisfied";
			const composition =
				verdictPinned === "confirmed" && acClosure === "asserted" ? "satisfied" : "unsatisfied";
			pi.appendEntry("gitjig-ship", { composition, verdictPinned, acClosure });
			// The durability turn (header): empty fixed content, so nothing
			// caller-held can ride it; `triggerTurn` makes an assistant message
			// land, which is what flushes the buffered entries to disk.
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [] }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}
