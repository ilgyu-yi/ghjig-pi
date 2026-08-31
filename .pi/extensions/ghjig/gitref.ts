/**
 * Subprocess-free reading of a repository's ref metadata (SPEC §3.9,
 * §3.10, §3.11).
 *
 * Every reading here is a **total function with exactly two outcomes**: a
 * valid value, or nothing plus the reason it is nothing (§3.9). The result
 * type states that shape, so no consumer can read an unvalidated value and
 * no third value exists that an equality test could silently consume.
 *
 * The layout rules this module implements, each of which is a wrong answer
 * if inverted:
 *
 *   - A `.git` entry may be a directory or a **file** carrying a `gitdir:`
 *     line (a linked worktree). Both resolve to a gitdir.
 *   - An **absent `commondir` file means commondir = gitdir**. Absence is
 *     the healthy default that every ordinary clone has, so a reader keyed
 *     on its presence withholds a verdict in every ordinary clone. A
 *     relative `commondir` resolves against the gitdir.
 *   - Shared refs (`refs/heads/**`, `refs/remotes/**`, `packed-refs`,
 *     `config`) live at the **commondir**; `HEAD` is **per-worktree** and
 *     lives at the gitdir. A reader that takes both from one place answers
 *     about the wrong tree in a linked worktree.
 *   - What a bare push lands on is decided by the **effective**
 *     `push.default` across the configuration precedence chain, not by the
 *     repository's own config file: a value set one layer up decides a
 *     push the local file says nothing about, and that is the wrong-allow
 *     direction. Reading more configuration *files* is still no subprocess.
 *   - A configuration layer is not one flat file. `include.path` and
 *     `includeIf.<condition>.path` **splice another file in at that point**,
 *     a definition may **share its line with its section header**, and the
 *     ambient `GIT_CONFIG_COUNT` channel carries settings in **no file at
 *     all**. A reader blind to any of them finds no value, falls back to the
 *     built-in, and answers about a push the built-in does not route — the
 *     same wrong-allow direction, reached silently. Each is followed here,
 *     and only what reading cannot settle — a condition keyed on something
 *     no file states, an include path that resolves to nothing nameable —
 *     is left unresolved for the caller to refuse on.
 *
 * Ref names are validated before they become paths: a name is a subject of
 * a decision, and a decision's own input must not be able to address
 * anything outside the ref store (§3.10).
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** A reading: a valid value, or nothing plus the reason (§3.9). */
export type Reading<T> = { ok: true; value: T } | { ok: false; why: string };

export interface GitLayout {
	/** Per-worktree directory — `HEAD` lives here. */
	gitdir: string;
	/** Shared directory — refs, `packed-refs` and `config` live here. */
	commondir: string;
}

/** Where HEAD points: at a branch, or at a commit that advances no branch. */
export type HeadState = { kind: "branch"; ref: string } | { kind: "detached" };

/** Bounds a symbolic-ref chain, so a cycle answers instead of spinning. */
const MAX_SYMREF_DEPTH = 10;

/** An object id, as a loose ref file or a packed-refs line holds it. */
const OBJECT_ID = /^[0-9a-fA-F]{40,64}$/;

/** The remote pointer the repository keeps its own default branch under. */
const ORIGIN_HEAD_REF = "refs/remotes/origin/HEAD";
const ORIGIN_BRANCH_PREFIX = "refs/remotes/origin/";
const LOCAL_BRANCH_PREFIX = "refs/heads/";

function failure(why: string): { ok: false; why: string } {
	return { ok: false, why };
}

function success<T>(value: T): { ok: true; value: T } {
	return { ok: true, value };
}

/** Reads a file, reporting the miss rather than throwing (§3.9). */
function readTextFile(path: string): Reading<string> {
	try {
		return success(readFileSync(path, "utf8"));
	} catch (error) {
		return failure(`${path} could not be read (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * True iff `name` is a ref name this module will turn into a path.
 *
 * The check is on the name's shape, not on the resulting path's prefix: a
 * decision's own input must not be able to address anything outside the ref
 * store, and a component-wise rule states that without depending on how the
 * platform spells a separator.
 */
function isWellFormedRefName(name: string): boolean {
	if (name === "" || name.length > 512) {
		return false;
	}
	if (!/^[A-Za-z0-9._\-/]+$/.test(name)) {
		return false;
	}
	const components = name.split("/");
	return components.every((component) => component !== "" && component !== "." && component !== "..");
}

/**
 * The `.git` entry governing `startDir`, found by walking upward.
 *
 * A miss here means "no repository", which is a different outcome from "a
 * repository whose layout cannot be read" — the two carry different fail
 * directions (§4.6 inertness vs §3.9 `git-commondir`), so they are two
 * readings rather than one.
 */
export function findGitEntry(startDir: string): Reading<string> {
	let current: string;
	try {
		current = realpathSync(startDir);
	} catch {
		return failure(`${startDir} does not resolve to a directory on this filesystem`);
	}
	for (;;) {
		const candidate = join(current, ".git");
		try {
			lstatSync(candidate);
			return success(candidate);
		} catch {
			// No entry here is an answer, not an error: the walk continues.
		}
		const parent = dirname(current);
		if (parent === current) {
			return failure(`no .git entry at or above ${startDir}`);
		}
		current = parent;
	}
}

/** Resolves a `.git` entry into the gitdir/commondir pair the refs live in. */
export function readLayout(gitEntry: string): Reading<GitLayout> {
	let gitdir: string;
	let entry: ReturnType<typeof statSync>;
	try {
		entry = statSync(gitEntry);
	} catch (error) {
		return failure(`${gitEntry} could not be examined (${error instanceof Error ? error.message : String(error)})`);
	}
	if (entry.isDirectory()) {
		gitdir = gitEntry;
	} else {
		const contents = readTextFile(gitEntry);
		if (!contents.ok) {
			return contents;
		}
		const line = contents.value.split("\n").find((candidate) => candidate.trim().startsWith("gitdir:"));
		if (line === undefined) {
			return failure(`${gitEntry} is a file that carries no gitdir: line`);
		}
		const target = line.trim().slice("gitdir:".length).trim();
		if (target === "") {
			return failure(`${gitEntry} names an empty gitdir`);
		}
		gitdir = isAbsolute(target) ? target : resolve(dirname(gitEntry), target);
		if (!existsSync(gitdir)) {
			return failure(`${gitEntry} names a gitdir that is not there (${gitdir})`);
		}
	}

	// Absence is the healthy default of an ordinary clone: no commondir file
	// means the shared directory IS the gitdir. Only a commondir file that is
	// present and unreadable leaves the pair unresolved.
	const commondirFile = join(gitdir, "commondir");
	if (!existsSync(commondirFile)) {
		return success({ gitdir, commondir: gitdir });
	}
	const declared = readTextFile(commondirFile);
	if (!declared.ok) {
		return declared;
	}
	const target = declared.value.trim();
	if (target === "") {
		return failure(`${commondirFile} is present but names no directory`);
	}
	const commondir = isAbsolute(target) ? target : resolve(gitdir, target);
	if (!existsSync(commondir)) {
		return failure(`${commondirFile} names a common directory that is not there (${commondir})`);
	}
	return success({ gitdir, commondir });
}

/** The loose ref file for `ref` — at the shared directory, where refs live. */
function looseRefPath(layout: GitLayout, ref: string): Reading<string> {
	if (!isWellFormedRefName(ref)) {
		return failure(`"${ref}" is not a well-formed ref name`);
	}
	return success(join(layout.commondir, ...ref.split("/")));
}

/** HEAD, read per worktree — the one file that is not shared. */
export function readHead(layout: GitLayout): Reading<HeadState> {
	const contents = readTextFile(join(layout.gitdir, "HEAD"));
	if (!contents.ok) {
		return contents;
	}
	const text = contents.value.trim();
	if (text.startsWith("ref:")) {
		const ref = text.slice("ref:".length).trim();
		if (!isWellFormedRefName(ref)) {
			return failure(`HEAD names "${ref}", which is not a well-formed ref name`);
		}
		return success({ kind: "branch", ref });
	}
	if (OBJECT_ID.test(text)) {
		return success({ kind: "detached" });
	}
	return failure("HEAD carries neither a ref nor an object id");
}

/** The packed ref table — an absent file is an empty table, not a failure. */
function readPackedRefs(layout: GitLayout): Reading<ReadonlyMap<string, string>> {
	const path = join(layout.commondir, "packed-refs");
	if (!existsSync(path)) {
		return success(new Map());
	}
	const contents = readTextFile(path);
	if (!contents.ok) {
		return contents;
	}
	const packed = new Map<string, string>();
	for (const line of contents.value.split("\n")) {
		if (line === "" || line.startsWith("#") || line.startsWith("^")) {
			continue;
		}
		const space = line.indexOf(" ");
		if (space === -1) {
			continue;
		}
		const objectId = line.slice(0, space);
		const name = line.slice(space + 1).trim();
		if (OBJECT_ID.test(objectId) && name !== "") {
			packed.set(name, objectId);
		}
	}
	return success(packed);
}

/**
 * The name `ref` ends at once every symbolic step has been followed.
 *
 * A spelling that resolves for nobody is a failure, never a name: reporting
 * the spelling back would let a later equality test derive "not equal" from
 * an operand nothing resolved, which is the collapse §3.9 forbids.
 */
export function canonicalRefName(layout: GitLayout, ref: string, depth = 0): Reading<string> {
	if (depth > MAX_SYMREF_DEPTH) {
		return failure(`the symbolic-ref chain from "${ref}" is longer than this reading follows`);
	}
	const path = looseRefPath(layout, ref);
	if (!path.ok) {
		return path;
	}
	if (existsSync(path.value)) {
		const contents = readTextFile(path.value);
		if (!contents.ok) {
			return contents;
		}
		const text = contents.value.trim();
		if (text.startsWith("ref:")) {
			return canonicalRefName(layout, text.slice("ref:".length).trim(), depth + 1);
		}
		if (OBJECT_ID.test(text)) {
			return success(ref);
		}
		return failure(`the ref file for "${ref}" carries neither a ref nor an object id`);
	}
	const packed = readPackedRefs(layout);
	if (!packed.ok) {
		return packed;
	}
	if (packed.value.has(ref)) {
		// A packed entry is an object id by construction: symbolic refs are not
		// packed, so a packed name is already its own canonical name.
		return success(ref);
	}
	return failure(`"${ref}" resolves through neither a loose ref file nor the packed table`);
}

/**
 * Whether two ref names are backed by one and the same file.
 *
 * The identity is the file's, taken without following links: two names over
 * one inode advance the same bytes while the link stands, which a name
 * comparison cannot see.
 */
export function sameRefFile(layout: GitLayout, left: string, right: string): Reading<boolean> {
	const leftPath = looseRefPath(layout, left);
	if (!leftPath.ok) {
		return leftPath;
	}
	const rightPath = looseRefPath(layout, right);
	if (!rightPath.ok) {
		return rightPath;
	}
	try {
		const leftEntry = lstatSync(leftPath.value);
		const rightEntry = lstatSync(rightPath.value);
		return success(leftEntry.dev === rightEntry.dev && leftEntry.ino === rightEntry.ino);
	} catch (error) {
		return failure(
			`one of "${left}" and "${right}" has no loose ref file to identify ` +
				`(${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

/**
 * The local branch ref the remote's own pointer names as the default one.
 *
 * The name is read from the repository, never carried in this module's text:
 * a repository whose default branch is called something else is governed by
 * its own answer.
 */
export function defaultBranchRefFromOriginHead(layout: GitLayout): Reading<string> {
	const path = looseRefPath(layout, ORIGIN_HEAD_REF);
	if (!path.ok) {
		return path;
	}
	if (!existsSync(path.value)) {
		return failure("the remote's default-branch pointer is absent");
	}
	const contents = readTextFile(path.value);
	if (!contents.ok) {
		return contents;
	}
	const text = contents.value.trim();
	if (!text.startsWith("ref:")) {
		return failure("the remote's default-branch pointer names no branch");
	}
	const target = text.slice("ref:".length).trim();
	if (!target.startsWith(ORIGIN_BRANCH_PREFIX)) {
		return failure("the remote's default-branch pointer does not name a branch of that remote");
	}
	const branch = target.slice(ORIGIN_BRANCH_PREFIX.length);
	const ref = `${LOCAL_BRANCH_PREFIX}${branch}`;
	if (!isWellFormedRefName(ref)) {
		return failure("the remote's default-branch pointer names an unusable ref");
	}
	return success(ref);
}

/** Bounds include following, so a cycle of includes answers instead of spinning. */
const MAX_INCLUDE_DEPTH = 10;

/** The section under which an unconditional include states its target. */
const INCLUDE_SECTION = "include";
/** The section under which a conditional include states its condition and target. */
const CONDITIONAL_INCLUDE_SECTION = "includeif";
/** The key both include forms state their target under. */
const INCLUDE_PATH_KEY = "path";

/** The conditional-include prefixes a file read can settle, case-sensitive and not. */
const GITDIR_CONDITION = "gitdir:";
const GITDIR_CONDITION_ICASE = "gitdir/i:";

/** The ambient key/value channel, as git names its three variables. */
const AMBIENT_COUNT = "GIT_CONFIG_COUNT";
const AMBIENT_KEY_PREFIX = "GIT_CONFIG_KEY_";
const AMBIENT_VALUE_PREFIX = "GIT_CONFIG_VALUE_";

/**
 * One setting, carried with the section it was written under.
 *
 * Entries are held in the order the layers state them, because a later
 * definition wins and an include contributes AT THE POINT it appears — a
 * shape a per-file "the value here" reading cannot express.
 */
interface ConfigEntry {
	/** Case-folded, as git folds a section name. */
	section: string;
	/** Literal, as git keeps a subsection's case. */
	subsection: string | undefined;
	/** Case-folded, as git folds a key. */
	key: string;
	value: string;
}

/** What a conditional include is decided against, resolved once per lookup. */
interface ConfigContext {
	/**
	 * The git directory as the filesystem resolves it. The pattern is matched
	 * against the resolved path, so a spelling that reaches the same directory
	 * through a link is the same directory here as it is for the reader this
	 * models.
	 */
	gitdirRealPath: string;
}

/** A section header split into its case-folded name and its literal subsection. */
function splitSectionHeader(header: string): { name: string; subsection: string | undefined } {
	const quote = header.indexOf('"');
	if (quote === -1) {
		return { name: header.trim().toLowerCase(), subsection: undefined };
	}
	const closing = header.lastIndexOf('"');
	return {
		name: header.slice(0, quote).trim().toLowerCase(),
		subsection: header.slice(quote + 1, closing === quote ? header.length : closing),
	};
}

/**
 * The index of the bracket that closes the header `line` opens, or -1.
 *
 * The header ENDS at that bracket; it is not the whole line. What follows on
 * the same line is a definition git honours, so a reader that consumed the
 * line whole would discard a setting that is in effect. The bracket is sought
 * outside the subsection's quotes, because a subsection may spell one.
 */
function sectionHeaderEnd(line: string): number {
	let quoted = false;
	for (let index = 1; index < line.length; index += 1) {
		const character = line[index];
		if (quoted && character === "\\") {
			index += 1;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (character === "]" && !quoted) {
			return index;
		}
	}
	return -1;
}

/** One `key = value` line, case-folded on the key as git folds it. */
function parseDefinition(line: string): { key: string; value: string } | undefined {
	const equals = line.indexOf("=");
	if (equals === -1) {
		return undefined;
	}
	const key = line.slice(0, equals).trim().toLowerCase();
	if (key === "") {
		return undefined;
	}
	return { key, value: line.slice(equals + 1).trim().replace(/^"(.*)"$/, "$1") };
}

/**
 * The path an include names, resolved as the file that states it resolves it.
 *
 * A relative path is relative to the INCLUDING FILE's directory, never to the
 * process's working directory: a fragment travels with the file that includes
 * it, and resolving against the caller's cwd would name a different file for
 * the same configuration. `~/` is the running actor's home directory, read at
 * run time — the home a decision depends on is the one the actor has, never a
 * value written here. `~user/` needs the account database, which no file read
 * answers, so it stays unresolved rather than guessed.
 */
function resolveConfigPath(raw: string, includingFile: string): Reading<string> {
	if (raw === "") {
		return failure(`${includingFile} states an include that names no path`);
	}
	if (raw === "~" || raw.startsWith("~/")) {
		const home = process.env.HOME;
		if (home === undefined || home === "") {
			return failure(`${includingFile} states a path under a home directory this context does not name`);
		}
		return success(raw === "~" ? home : join(home, raw.slice(2)));
	}
	if (raw.startsWith("~")) {
		return failure(`${includingFile} states a path under another account's home directory, which no file read resolves`);
	}
	return success(isAbsolute(raw) ? raw : resolve(dirname(includingFile), raw));
}

/**
 * Whether `path` is what `pattern` names, under git's own path globbing.
 *
 * `**` crosses directory separators and `*` does not: a pattern naming one
 * directory would otherwise reach every tree below it, and a conditional
 * include is a statement about one directory unless it says otherwise.
 */
function pathMatchesPattern(pattern: string, path: string, caseInsensitive: boolean): boolean {
	let expression = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				expression += ".*";
				index += 1;
			} else {
				expression += "[^/]*";
			}
			continue;
		}
		if (character === "?") {
			expression += "[^/]";
			continue;
		}
		expression += "\\^$.|?*+()[]{}".includes(character) ? `\\${character}` : character;
	}
	return new RegExp(`^${expression}$`, caseInsensitive ? "i" : "").test(path);
}

/**
 * A `gitdir:` condition's raw pattern, normalised the way git normalises it.
 *
 * The three rewrites are the condition's meaning, not conveniences: a bare
 * name is a directory anywhere (`**​/` prepended), a trailing separator names
 * everything BELOW that directory and therefore not the directory itself
 * (`**` appended), and `./` is relative to the file stating the condition.
 */
function gitdirPattern(raw: string, includingFile: string): Reading<string> {
	if (raw === "") {
		return failure(`${includingFile} states a conditional include with an empty git-directory pattern`);
	}
	const namesEverythingBelow = raw.endsWith("/");
	const trimmed = namesEverythingBelow ? raw.replace(/\/+$/, "") : raw;
	let pattern: string;
	if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("./")) {
		const resolved = resolveConfigPath(trimmed, includingFile);
		if (!resolved.ok) {
			return resolved;
		}
		pattern = resolved.value;
	} else if (trimmed.startsWith("~")) {
		return failure(`${includingFile} keys a conditional include on another account's home directory`);
	} else if (isAbsolute(trimmed) || trimmed.startsWith("**")) {
		pattern = trimmed;
	} else {
		pattern = `**/${trimmed}`;
	}
	return success(namesEverythingBelow ? `${pattern}/**` : pattern);
}

/**
 * Whether a conditional include's condition holds here.
 *
 * A condition this reader cannot settle from files — one keyed on the checked
 * out branch, or on another remote's configured url — is a failure and never
 * a `false`: reading it as "does not apply" would drop whatever the included
 * file sets, which is the silent wrong-allow direction (§3.9).
 */
function conditionHolds(condition: string, includingFile: string, context: ConfigContext): Reading<boolean> {
	const caseInsensitive = condition.startsWith(GITDIR_CONDITION_ICASE);
	if (!caseInsensitive && !condition.startsWith(GITDIR_CONDITION)) {
		return failure(
			`${includingFile} keys a conditional include on "${condition}", which no configuration file states`,
		);
	}
	const raw = condition.slice((caseInsensitive ? GITDIR_CONDITION_ICASE : GITDIR_CONDITION).length);
	const pattern = gitdirPattern(raw, includingFile);
	if (!pattern.ok) {
		return pattern;
	}
	return success(pathMatchesPattern(pattern.value, context.gitdirRealPath, caseInsensitive));
}

/**
 * Every setting one configuration file puts in effect, includes spliced in.
 *
 * A file that is not there contributes nothing — that is what an include
 * naming an absent file does for the reader this models, and it is also every
 * layer of an ordinary clone's chain. A file that is present and unreadable
 * leaves the layer unmeasured, which is a failure, not an emptiness.
 */
function configEntriesFromFile(file: string, context: ConfigContext, depth: number): Reading<ConfigEntry[]> {
	if (depth > MAX_INCLUDE_DEPTH) {
		return failure(`configuration includes nest deeper than ${MAX_INCLUDE_DEPTH} files at ${file}`);
	}
	if (!existsSync(file)) {
		return success([]);
	}
	const contents = readTextFile(file);
	if (!contents.ok) {
		return contents;
	}
	const entries: ConfigEntry[] = [];
	let section = "";
	let subsection: string | undefined;
	for (const rawLine of contents.value.split("\n")) {
		let line = rawLine.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) {
			continue;
		}
		if (line.startsWith("[")) {
			const close = sectionHeaderEnd(line);
			if (close === -1) {
				continue;
			}
			const header = splitSectionHeader(line.slice(1, close));
			section = header.name;
			subsection = header.subsection;
			line = line.slice(close + 1).trim();
			if (line === "" || line.startsWith("#") || line.startsWith(";")) {
				continue;
			}
		}
		const definition = parseDefinition(line);
		if (definition === undefined) {
			continue;
		}
		const isInclude =
			definition.key === INCLUDE_PATH_KEY &&
			((section === INCLUDE_SECTION && subsection === undefined) ||
				(section === CONDITIONAL_INCLUDE_SECTION && subsection !== undefined));
		if (!isInclude) {
			entries.push({ section, subsection, key: definition.key, value: definition.value });
			continue;
		}
		if (subsection !== undefined) {
			const holds = conditionHolds(subsection, file, context);
			if (!holds.ok) {
				return holds;
			}
			if (!holds.value) {
				continue;
			}
		}
		const target = resolveConfigPath(definition.value, file);
		if (!target.ok) {
			return target;
		}
		// Spliced in place: an include contributes where it appears, so what the
		// including file states after it still wins over what it brought in.
		const included = configEntriesFromFile(target.value, context, depth + 1);
		if (!included.ok) {
			return included;
		}
		entries.push(...included.value);
	}
	return success(entries);
}

/** Splits `section.key` or `section.subsection.key` where git splits it. */
function splitDottedKey(dotted: string): { section: string; subsection: string | undefined; key: string } | undefined {
	const first = dotted.indexOf(".");
	const last = dotted.lastIndexOf(".");
	if (first === -1) {
		return undefined;
	}
	const section = dotted.slice(0, first).toLowerCase();
	const key = dotted.slice(last + 1).toLowerCase();
	if (section === "" || key === "") {
		return undefined;
	}
	// The subsection is everything between the FIRST and LAST separator, so a
	// subsection spelling one of its own stays one subsection.
	return { section, subsection: first === last ? undefined : dotted.slice(first + 1, last), key };
}

/**
 * The settings the ambient key/value channel puts in effect.
 *
 * This channel needs no file, and the git that would run honours it above
 * every file, so a reader that only walks files answers about a different
 * configuration than the one in effect. A count that states a number of pairs
 * and does not carry them leaves the layer unmeasured, which is a failure:
 * treating a half-stated channel as empty is the wrong-allow direction (§3.9).
 */
function ambientConfigEntries(): Reading<ConfigEntry[]> {
	const declared = process.env[AMBIENT_COUNT];
	if (declared === undefined || declared.trim() === "") {
		return success([]);
	}
	if (!/^[0-9]+$/.test(declared.trim())) {
		return failure(`${AMBIENT_COUNT} states "${declared}", which counts no settings`);
	}
	const count = Number(declared.trim());
	const entries: ConfigEntry[] = [];
	for (let index = 0; index < count; index += 1) {
		const dotted = process.env[`${AMBIENT_KEY_PREFIX}${index}`];
		const value = process.env[`${AMBIENT_VALUE_PREFIX}${index}`];
		if (dotted === undefined || value === undefined) {
			return failure(`${AMBIENT_COUNT} states ${count} settings and the pair at ${index} is not both present`);
		}
		const split = splitDottedKey(dotted);
		if (split === undefined) {
			return failure(`${AMBIENT_KEY_PREFIX}${index} names "${dotted}", which is no section and key`);
		}
		entries.push({ ...split, value });
	}
	return success(entries);
}

/**
 * The configuration files that decide a value, in precedence order.
 *
 * The environment selects the FILES in this execution context, which is the
 * same selection the git that would run performs. What it selects DOES reach
 * enforcement: the file `GIT_CONFIG_GLOBAL` names can carry the
 * `push.default` that routes a bare push's destination. What §4.6 keeps off
 * the hot path is a value that decides for THIS gate alone — no variable
 * read here or in the ambient channel names a verdict, an arm, or a disarm,
 * and every one of them decides the same way for the git the actor would
 * have run by hand. A reading that ignored them would describe a
 * configuration nobody runs under.
 */
function configurationChain(layout: GitLayout): string[] {
	const chain: string[] = [];
	if (process.env.GIT_CONFIG_NOSYSTEM !== "1") {
		chain.push(process.env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig");
	}
	const globalOverride = process.env.GIT_CONFIG_GLOBAL;
	if (globalOverride !== undefined) {
		chain.push(globalOverride);
	} else {
		const xdg = process.env.XDG_CONFIG_HOME;
		const home = process.env.HOME;
		if (xdg !== undefined && xdg !== "") {
			chain.push(join(xdg, "git", "config"));
		} else if (home !== undefined && home !== "") {
			chain.push(join(home, ".config", "git", "config"));
		}
		if (home !== undefined && home !== "") {
			chain.push(join(home, ".gitconfig"));
		}
	}
	chain.push(join(layout.commondir, "config"));
	return chain;
}

/**
 * The effective value of one setting — what the git that runs would use.
 *
 * `section` is spelled as a header spells it — `push`, or `branch "topic"`
 * for a subsection. Git folds the section name's case and keeps the
 * subsection's, so a branch called `Topic` is not the branch called `topic`,
 * and this reader makes the same distinction.
 *
 * The layers are walked in precedence order and the LAST definition wins,
 * with the ambient channel last because that is where the reader this models
 * puts it. A file that is absent contributes nothing; a file that is present
 * and unreadable, an include that resolves to nothing nameable, or a
 * condition no file settles leaves the effective value unmeasured, and an
 * unmeasured value refuses rather than falling back to a built-in (§3.9).
 */
function effectiveConfigValue(layout: GitLayout, section: string, key: string): Reading<string | undefined> {
	const wanted = splitSectionHeader(section);
	const wantedKey = key.toLowerCase();
	let gitdirRealPath: string;
	try {
		gitdirRealPath = realpathSync(layout.gitdir);
	} catch {
		gitdirRealPath = layout.gitdir;
	}
	const context: ConfigContext = { gitdirRealPath };
	const layers: ConfigEntry[][] = [];
	for (const file of configurationChain(layout)) {
		if (file === "/dev/null") {
			continue;
		}
		const entries = configEntriesFromFile(file, context, 0);
		if (!entries.ok) {
			return entries;
		}
		layers.push(entries.value);
	}
	const ambient = ambientConfigEntries();
	if (!ambient.ok) {
		return ambient;
	}
	layers.push(ambient.value);

	let effective: string | undefined;
	for (const entries of layers) {
		for (const entry of entries) {
			if (entry.section === wanted.name && entry.subsection === wanted.subsection && entry.key === wantedKey) {
				effective = entry.value;
			}
		}
	}
	return success(effective);
}

export function effectivePushDefault(layout: GitLayout): Reading<string> {
	const configured = effectiveConfigValue(layout, "push", "default");
	if (!configured.ok) {
		return configured;
	}
	// git's own built-in when no layer sets one.
	return success(configured.value ?? "simple");
}

/**
 * The local ref a branch's upstream names — where `push.default = upstream`
 * (and its synonym `tracking`) sends a bare push.
 *
 * `branch.<name>.merge` names the branch ON THE FAR END, and that name may
 * differ from the one HEAD carries: a topic branch tracking the default
 * branch pushes onto the default branch. The name is returned as the local
 * ref it corresponds to, which is how a refspec destination is read too, so
 * the identity predicate is asked one question rather than two.
 *
 * An absent or malformed configuration is a failure, never a fallback to
 * HEAD: falling back would answer about a branch the push does not touch,
 * and an unmeasured destination refuses (§3.9).
 */
export function upstreamBranchRef(layout: GitLayout, headRef: string): Reading<string> {
	if (!headRef.startsWith(LOCAL_BRANCH_PREFIX)) {
		return failure(`HEAD names "${headRef}", which is not a local branch, so it configures no upstream`);
	}
	const branch = headRef.slice(LOCAL_BRANCH_PREFIX.length);
	const merge = effectiveConfigValue(layout, `branch "${branch}"`, "merge");
	if (!merge.ok) {
		return merge;
	}
	if (merge.value === undefined || merge.value === "") {
		return failure(`branch.${branch}.merge is not configured, so this branch names no upstream`);
	}
	if (merge.value.startsWith("refs/") && !merge.value.startsWith(LOCAL_BRANCH_PREFIX)) {
		return failure(`branch.${branch}.merge names "${merge.value}", which is not a branch`);
	}
	const ref = merge.value.startsWith(LOCAL_BRANCH_PREFIX) ? merge.value : `${LOCAL_BRANCH_PREFIX}${merge.value}`;
	if (!isWellFormedRefName(ref)) {
		return failure(`branch.${branch}.merge names "${merge.value}", which is not a well-formed ref name`);
	}
	return success(ref);
}
