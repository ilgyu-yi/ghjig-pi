/**
 * The protected-branch predicate — the class's one owning enforcement
 * point (SPEC §3.11 predicate ownership, §3.9, §3.3).
 *
 * Every other surface that asks "is this ref protected?" is a call site of
 * this function; a second implementation of the property would be a
 * divergence surface rather than redundancy.
 *
 * **Protection binds to what a ref is, never to how it is spelled**
 * (§3.11). That property is the composition of two legs, and neither leg
 * alone decides it:
 *
 *   - the **resolved-name** leg follows symbolic refs to the name a
 *     spelling ends at, which is the only leg that catches an alias;
 *   - the **same-file** leg compares the identity of the files behind two
 *     names, which is the only leg that catches a spelling that reaches
 *     one file through two names.
 *
 * Object-id equality is not a leg and cannot become one: a freshly cut
 * topic branch holds the default branch's object id until its first
 * commit, and it must pass.
 *
 * **An unresolved operand never produces "not equal."** Each leg is a
 * reading with exactly two outcomes, and every equality test sits inside
 * the resolved branch of that reading, so "they are not equal, therefore
 * allow" is underivable from an operand nothing resolved. When BOTH legs
 * are unresolvable the verdict is a refusal — that a subprocess would fail
 * on the same spelling is not a licence to approve it (§3.9).
 *
 * **No branch name appears in this text.** The protected identity is read
 * from the repository's own remote pointer; a repository whose default
 * branch is called something else is governed by its own answer, and a
 * branch that merely carries a common name is an ordinary topic branch.
 * The pointer's absence refuses and names the command that restores it.
 */
import {
	canonicalRefName,
	defaultBranchRefFromOriginHead,
	type GitLayout,
	type Reading,
	sameRefFile,
} from "./gitref.ts";

/** The gate class's identity — the name every record of a decision carries. */
export const PROTECTED_BRANCH_CATEGORY = "protected-branch";

/** The recovery that is live where the remote's own pointer is missing. */
export const ORIGIN_HEAD_RECOVERY = "git remote set-head origin --auto";

/** The recovery that is live where a spelling resolves for nobody. */
export const REF_IDENTITY_RECOVERY =
	"point HEAD at a ref that resolves (`git symbolic-ref HEAD refs/heads/<branch>`), " +
	"or name the target as a ref this repository holds";

export type Protection =
	| { kind: "protected"; via: "resolved-name" | "same-file" }
	| { kind: "unprotected" }
	| { kind: "unresolvable"; postureKey: string; why: string; recovery: string };

/** The two names' resolved identities, compared only where both resolved. */
function equalByResolvedName(layout: GitLayout, target: string, protectedRef: string): Reading<boolean> {
	const targetName = canonicalRefName(layout, target);
	if (!targetName.ok) {
		return targetName;
	}
	const protectedName = canonicalRefName(layout, protectedRef);
	if (!protectedName.ok) {
		return protectedName;
	}
	return { ok: true, value: targetName.value === protectedName.value };
}

/**
 * Decides whether `targetRef` is the repository's protected branch.
 *
 * `targetRef` is a ref name as the command lands on it; it is never
 * assumed to resolve.
 */
export function decideProtectedRef(layout: GitLayout, targetRef: string): Protection {
	const protectedRef = defaultBranchRefFromOriginHead(layout);
	if (!protectedRef.ok) {
		return {
			kind: "unresolvable",
			postureKey: "default-branch-source",
			why: `the branch this repository treats as its default cannot be named (${protectedRef.why})`,
			recovery: ORIGIN_HEAD_RECOVERY,
		};
	}

	const byName = equalByResolvedName(layout, targetRef, protectedRef.value);
	const byFile = sameRefFile(layout, targetRef, protectedRef.value);

	if (byName.ok && byName.value) {
		return { kind: "protected", via: "resolved-name" };
	}
	if (byFile.ok && byFile.value) {
		return { kind: "protected", via: "same-file" };
	}
	if (!byName.ok && !byFile.ok) {
		return {
			kind: "unresolvable",
			postureKey: "ref-identity",
			why: `what this command lands on resolves through neither identity leg (${byName.why}; ${byFile.why})`,
			recovery: REF_IDENTITY_RECOVERY,
		};
	}
	return { kind: "unprotected" };
}

/**
 * Whether the protected branch is itself present in this repository.
 *
 * The question a whole-repository push asks: such a push names a ref set
 * rather than a ref, and the protected branch is in that set when the
 * repository holds it. Asked through the same predicate, so the two
 * questions cannot answer differently — and with the same two-sided
 * outcome: a default branch this repository does not hold does not resolve
 * through either identity leg, so it answers `unresolvable` and refuses.
 * The absent case is never read as `unprotected`; an unmeasured ref set is
 * not an approval (§3.9).
 */
export function decideProtectedRefPresence(layout: GitLayout): Protection {
	const protectedRef = defaultBranchRefFromOriginHead(layout);
	if (!protectedRef.ok) {
		return {
			kind: "unresolvable",
			postureKey: "default-branch-source",
			why: `the branch this repository treats as its default cannot be named (${protectedRef.why})`,
			recovery: ORIGIN_HEAD_RECOVERY,
		};
	}
	return decideProtectedRef(layout, protectedRef.value);
}
