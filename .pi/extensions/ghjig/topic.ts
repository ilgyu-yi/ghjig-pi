/**
 * `/ghjig-topic` — the in-flow authoring affordance the protected-branch
 * class owes (SPEC §3.3, §3.11, §3.10).
 *
 * §3.11: "Every enforced gate owes an in-flow authoring affordance that
 * repairs rather than reports." A block whose only remedy is a manual
 * sequence manufactures post-hoc repair commits; this creates the topic
 * branch and switches to it, so the blocked actor's next step is one
 * command.
 *
 * The branch convention is §1.1's, referenced as the rule source rather
 * than re-derived here: a second statement of the grammar would be a
 * second home for it, and the two would drift. The argument is the branch
 * name the convention prescribes.
 *
 * **The result is admitted on output validity alone** (§3.10): after the
 * delegate runs, HEAD is re-read through the same primitive the gate reads
 * it with, and the affordance reports success only if HEAD now names the
 * intended branch. Neither the delegate's exit status nor a presence probe
 * is consulted — both answer "did something run?" in place of "may I use
 * this result?".
 *
 * The affordance's own write is examined by the same gate rather than by a
 * carve-out, so the affordance and the gate agree by construction.
 *
 * Refusals name a live recovery: a detached HEAD and an existing branch
 * are both repairable, and each says how.
 */
import { spawnSync } from "node:child_process";
import { findGitEntry, readHead, readLayout } from "./gitref.ts";
import { decideCommand } from "./gate.ts";

export interface TopicRequest {
	cwd: string;
	/** The branch name, spelled as §1.1's convention prescribes. */
	branch: string;
}

export interface TopicResult {
	ok: boolean;
	message: string;
}

const PREFIX = "[ghjig] /ghjig-topic";

/** The command the affordance delegates to, as one place. */
function switchCommand(branch: string): string[] {
	return ["switch", "-c", branch];
}

export function createTopicBranch(request: TopicRequest): TopicResult {
	const branch = request.branch.trim();
	if (branch === "") {
		return {
			ok: false,
			message: `${PREFIX}: no branch name given. Recovery: run \`/ghjig-topic <branch>\`, spelled as SPEC §1.1's branch convention prescribes.`,
		};
	}

	const entry = findGitEntry(request.cwd);
	if (!entry.ok) {
		return {
			ok: false,
			message: `${PREFIX}: this working directory is in no repository. Recovery: run this from inside the repository the work belongs to.`,
		};
	}
	const layout = readLayout(entry.value);
	if (!layout.ok) {
		return {
			ok: false,
			message: `${PREFIX}: this repository's ref store cannot be located (${layout.why}). Recovery: repair the repository's git directory.`,
		};
	}
	const before = readHead(layout.value);
	if (!before.ok) {
		return {
			ok: false,
			message: `${PREFIX}: HEAD cannot be read (${before.why}). Recovery: restore HEAD (\`git symbolic-ref HEAD refs/heads/<branch>\`).`,
		};
	}
	if (before.value.kind === "detached") {
		return {
			ok: false,
			message: `${PREFIX}: HEAD is detached, so there is no branch to cut this one from. Recovery: check out a branch first (\`git switch <branch>\`), then run this again.`,
		};
	}
	const intended = `refs/heads/${branch}`;
	if (before.value.ref === intended) {
		return { ok: true, message: `${PREFIX}: already on ${branch}.` };
	}

	// The affordance submits its own write to the same reading any actor's
	// command receives, so it can hold no exemption the gate does not grant
	// everyone (§3.3). What this asserts is the absence of a carve-out, not
	// the presence of a check: creating a branch advances no protected ref,
	// so the reading allows it, and this call is expected to allow. It stays
	// because routing through the one reading is what makes the absence
	// structural — a later change that made branch creation guarded would be
	// caught here rather than silently exempted.
	const examined = decideCommand({ cwd: request.cwd, command: `git ${switchCommand(branch).join(" ")}` });
	if (examined.decision !== "allow") {
		return { ok: false, message: examined.message };
	}

	spawnSync("git", switchCommand(branch), { cwd: request.cwd, encoding: "utf8" });

	// Output validity alone: what HEAD says now, read through the gate's own
	// primitive. A delegate that reported success while leaving HEAD where it
	// was is not a repair, and a delegate that reported failure while moving
	// HEAD is one.
	const after = readHead(layout.value);
	if (!after.ok || after.value.kind !== "branch") {
		return {
			ok: false,
			message: `${PREFIX}: the branch was not created — HEAD does not name one afterwards. Recovery: check whether \`${branch}\` already exists (\`git branch --list\`), and choose a name that is free.`,
		};
	}
	if (after.value.ref !== intended) {
		return {
			ok: false,
			message: `${PREFIX}: the branch was not created — HEAD still names ${after.value.ref}. Recovery: \`${branch}\` most likely exists already; choose a free name, or switch to it (\`git switch ${branch}\`).`,
		};
	}
	return { ok: true, message: `${PREFIX}: on ${branch}. The work belongs here; open a PR from it (SPEC §1.1).` };
}
