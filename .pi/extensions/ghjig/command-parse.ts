/**
 * Three-valued command reading for the protected-branch gate (SPEC §3.9,
 * §3.11).
 *
 * The reading is three-valued because the third value is the point:
 * `none` (this command lands on no ref), `target` (it lands on exactly this
 * ref spec), and `undecidable` (a guarded action may be present and the
 * string does not fix its target). A two-valued reading has nowhere to put
 * the third case and must fold it into one of the other two; folded into
 * `none` it is a silent wrong allow, which §3.9 forbids — an unmeasurable
 * input refuses, it never approves.
 *
 * **`none` IS A CLAIM, AND THE READING MAY ONLY MAKE IT WHEN IT CAN ACCOUNT
 * FOR THE STRING.** That is this module's whole shape, and it is a
 * DIRECTION rather than a list. For each segment the reading either
 * accounts for what runs — an ordinary program with no guarded git
 * invocation attributable to it — or resolves a target, or attributes
 * nothing at all. The unattributed case is the DEFAULT case: a segment
 * whose command word the reading cannot resolve, in a string that carries a
 * guarded subcommand word, is `undecidable`, and the gate refuses it. No
 * enumeration of the shapes a shell can spell is ever complete, so the
 * safety is carried by that default and never by the recognition aids
 * below.
 *
 * Each named set here — launchers, reserved words, interpreters, git's own
 * options — is a RECOGNITION AID: it exists to let the reading account for
 * a form precisely, so an ordinary session is not refused and a resolved
 * target is blocked with the recovery it deserves rather than refused with
 * a message about a reading that did happen. Growing one of these sets
 * widens what the reading can EXPLAIN; it is not what keeps the gate
 * closed. A reader adding a member to any of them is improving the ceiling,
 * not the floor.
 *
 * The reading is lexical and total: it never executes, expands, or probes
 * anything, so its answer is a property of the string alone. Where the
 * string's structure cannot be recovered — an unbalanced quote, a
 * substitution, a grouping, an interpreter handed its program as text — the
 * reading says so rather than guessing.
 *
 * Force flags carry no arm of their own: `--force`, `-f` and
 * `--force-with-lease` leave the target unchanged, so a forced push is
 * refused as the protected-ref push it is (§3.3's force-push row, covered
 * by subsumption). The invariant that keeps that true is that the force
 * flags never reach the refspec extractor.
 *
 * **The command word is not the first token.** An assignment prefix, a
 * redirection, a compound statement's keyword and a launcher word can all
 * occupy the first position while the action that advances a ref runs
 * anyway, so the head is normalized before anything asks what is running.
 * Where that normalization leaves a literal `git` and a spelled-out ref,
 * the string fixes the target exactly as the plain spelling does and the
 * outcome is the plain spelling's — §3.9 has a degraded measurement refuse
 * only the inputs it would mis-measure, and folding a resolved target into
 * "not readable" refuses wider than the actual loss.
 *
 * **An interpreter handed its program as TEXT is not opened.** `bash -c "…"`
 * and `eval "…"` carry a program this reading does not parse, so the
 * segment attributes nothing and the default decides: a guarded subcommand
 * word anywhere in the command makes it `undecidable`. A command that NAMES
 * a script — `source ./env.sh`, `bash deploy.sh` — carries only a name and
 * no program text, so it is an ordinary program; refusing it for existing
 * would refuse most of a working session (§3.6). That is the
 * `session-spawned-script` residual, homed in `residuals.ts` at the tiers
 * that bind below the session (§3.2, §3.3).
 */

/** The reading's result. `refSpec` is null when the command carries none. */
export type ParsedCommand =
	| { kind: "none" }
	| { kind: "target"; action: "commit" | "push"; refSpec: string | null }
	| { kind: "undecidable"; why: string };

/** One word of one segment, with the shell features that produced it. */
interface Token {
	/** The word with quoting removed — what the shell would pass on. */
	value: string;
	/** True when any part of the word came out of quotes. */
	quoted: boolean;
	/** True when an unquoted or double-quoted `$` could expand here. */
	expansion: boolean;
	/** True when a command substitution contributed to the word. */
	substitution: boolean;
}

interface Segment {
	tokens: Token[];
}

interface Lexed {
	segments: Segment[];
	/** True when the string groups commands, so segment order is not linear. */
	grouped: boolean;
}

type LexResult = { ok: true; lexed: Lexed } | { ok: false; why: string };

/** Guarded actions: the two subcommands that advance a ref. */
const GUARDED_SUBCOMMANDS = new Set(["commit", "push"]);

/**
 * A guarded subcommand word, anywhere in a word the command carries.
 *
 * The reading is lexical, so this is the one part of a guarded invocation
 * that no launcher, path spelling, or wrapper can take out of the string:
 * to run `git commit`, the word `commit` has to be somewhere in the words
 * the shell was handed. It is consulted only for a segment the reading
 * could attribute nothing to, where it decides between "unaccounted, and
 * the string carries a guarded subcommand" — which refuses — and
 * "unaccounted, and no guarded subcommand is anywhere in it" — which is
 * accounted for. A subcommand assembled at run time out of pieces is the
 * `substituted-command-word` residual in `residuals.ts`.
 */
const GUARDED_SUBCOMMAND_MENTION = /\b(?:commit|push)\b/;

/**
 * Options before the subcommand that move the invocation to another
 * repository, work tree, or configuration. Each of them makes the target
 * the gate would measure a different one from the target that runs, so the
 * string no longer determines the action's subject.
 */
const REDIRECTING_GLOBAL_OPTIONS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--bare", "--exec-path"];

/** Options before the subcommand that change nothing the gate measures. */
const INERT_GLOBAL_OPTIONS = new Set([
	"--no-pager",
	"-P",
	"--paginate",
	"-p",
	"--no-replace-objects",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
]);

/** Push options that take no value and leave the target unchanged. */
const INERT_PUSH_FLAGS = new Set([
	"--force",
	"-f",
	"--delete",
	"-d",
	"--tags",
	"--follow-tags",
	"--set-upstream",
	"-u",
	"--quiet",
	"-q",
	"--verbose",
	"-v",
	"--porcelain",
	"--dry-run",
	"-n",
	"--atomic",
	"--no-verify",
	"--verify",
	"--progress",
	"--no-progress",
	"--prune",
	"--thin",
	"--no-thin",
	"--ipv4",
	"-4",
	"--ipv6",
	"-6",
	"--no-force-with-lease",
	"--signed",
	"--no-signed",
	"--no-recurse-submodules",
]);

/** Push options whose whole-repository target set no single refspec names. */
const WHOLE_REPOSITORY_PUSH_FLAGS = new Set(["--all", "--mirror", "--branches"]);

/** Words that move the shell's working directory, and with it the repository. */
const DIRECTORY_CHANGING_WORDS = new Set(["cd", "chdir", "pushd", "popd"]);

/**
 * Words that open a compound statement, so the word after them is the
 * command rather than the command itself.
 *
 * A recognition aid for the ceiling AND for the message: skipping them is
 * what lets `if true; then git commit -m x; fi` reach the block that names
 * the recovery, instead of refusing a command whose target the string still
 * fixes.
 */
const RESERVED_WORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"!",
]);

/**
 * Environment assignments that move git's repository, work tree, or
 * configuration — the environment spellings of the redirecting options.
 * The two spellings do the same thing, so neither may be the permissive
 * one (§3.11).
 */
const REDIRECTING_ASSIGNMENTS = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_COUNT",
	"GIT_CEILING_DIRECTORIES",
]);

/** One leading `NAME=VALUE` word, as the shell reads an assignment prefix. */
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * Words that run another program under their own name, where the program
 * they run is a WORD in this same string.
 *
 * A recognition aid, and deliberately a short one. The reading looks past
 * these and no others: looking past every unrecognised head would refuse
 * `echo git push origin main`, an ordinary command whose git token is an
 * argument. A launcher this set does not name reads as an ordinary program
 * and is accounted for — the declared `unknown-launcher-target` residual in
 * `residuals.ts`, which §3.2 makes admissible because this tier is
 * in-session mistake prevention rather than a security boundary. Adding a
 * member here sharpens what the reading can explain; the default is what
 * carries the safety.
 */
const LAUNCHER_WORDS = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"builtin",
	"exec",
	"nohup",
	"timeout",
	"xargs",
	"time",
	"nice",
	"stdbuf",
	"setsid",
]);

/** Interpreters whose arguments ARE their program text. */
const PROGRAM_TEXT_WORDS = new Set(["eval"]);

/** Shells whose program text is present only behind a `-c`-bearing flag. */
const SHELL_WORDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/**
 * A flag that makes a shell's next argument its program text.
 *
 * Matched as a clustered short-flag form rather than as the exact token
 * `-c`, because `-lc`, `-ec`, `-xc` and `-ic` hand over the program exactly
 * as `-c` does; quoting the flag does not change what the shell does with
 * it, so quoting is not consulted.
 */
const PROGRAM_TEXT_FLAG = /^-[A-Za-z]*c$/;

function newToken(): Token {
	return { value: "", quoted: false, expansion: false, substitution: false };
}

/**
 * Consumes a `$(…)` body from `index`, tracking nesting so the terminator
 * found is the matching one. Returns the index after the body, so the
 * body's own separators can never be read as the outer command's structure.
 *
 * The body is not read: the word is marked as substituted, and a
 * substituted word is one the reading does not resolve. Consumption exists
 * for the segmentation invariant alone — a `;` or `&&` inside a
 * substitution is the body's structure, not this command's.
 */
function consumeSubstitution(command: string, index: number, token: Token): number {
	let depth = 0;
	let cursor = index + 1;
	while (cursor < command.length) {
		const char = command[cursor];
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				token.substitution = true;
				token.value += command.slice(index, cursor + 1);
				return cursor + 1;
			}
		}
		cursor += 1;
	}
	// Unterminated: the word is marked as substituted either way — an unread
	// body is exactly the case that must not be mistaken for a fixed target.
	token.substitution = true;
	token.value += command.slice(index);
	return command.length;
}

/** Consumes a backtick substitution, with the same effect as `$(…)`. */
function consumeBacktick(command: string, index: number, token: Token): number {
	const end = command.indexOf("`", index + 1);
	const stop = end === -1 ? command.length : end;
	token.substitution = true;
	token.value += command.slice(index, stop + 1);
	return stop + 1;
}

/**
 * Consumes a `${…}` expansion into the word it belongs to.
 *
 * The braces are the expansion's own syntax, not a grouping: reading them
 * as one splits `${GIT} push origin main` before anything can see that a
 * word in command position is assembled at run time.
 */
function consumeBraceExpansion(command: string, index: number, token: Token): number {
	const end = command.indexOf("}", index + 2);
	const stop = end === -1 ? command.length : end + 1;
	token.expansion = true;
	token.value += command.slice(index, stop);
	return stop;
}

/**
 * Reads a here-document's delimiter word, starting after `<<` or `<<-`.
 * Returns the delimiter with its quoting removed, and where the operator
 * ends. Quoting the delimiter changes what the shell expands INSIDE the
 * body, never where the body ends, so both spellings are read here.
 */
function readHeredocDelimiter(command: string, start: number): { delimiter: string; end: number } {
	let cursor = start;
	let delimiter = "";
	while (cursor < command.length && (command[cursor] === " " || command[cursor] === "\t")) {
		cursor += 1;
	}
	while (cursor < command.length) {
		const char = command[cursor];
		if (char === "'" || char === '"') {
			cursor += 1;
			while (cursor < command.length && command[cursor] !== char) {
				delimiter += command[cursor];
				cursor += 1;
			}
			cursor += 1;
			continue;
		}
		if (char === "\\") {
			cursor += 1;
			if (cursor < command.length) {
				delimiter += command[cursor];
				cursor += 1;
			}
			continue;
		}
		if (/[\s;&|<>()]/.test(char)) {
			break;
		}
		delimiter += char;
		cursor += 1;
	}
	return { delimiter, end: cursor };
}

/**
 * Skips the bodies of the here-documents pending at this newline.
 *
 * A here-document body is DATA the shell feeds to a program's input, not a
 * sequence of commands: writing a document or a CI snippet that contains a
 * push line is ordinary work, and lexing those lines as live segments
 * refuses it (§3.6). An unterminated body runs to the end of the string,
 * which is also where the shell would look for its delimiter.
 */
function skipHeredocBodies(command: string, index: number, delimiters: string[]): number {
	let cursor = index;
	for (const delimiter of delimiters) {
		while (cursor < command.length) {
			const lineEnd = command.indexOf("\n", cursor);
			const stop = lineEnd === -1 ? command.length : lineEnd;
			const line = command.slice(cursor, stop);
			cursor = lineEnd === -1 ? command.length : lineEnd + 1;
			// `<<-` strips leading tabs from the terminator, and a plain `<<`
			// requires the line to be the delimiter alone; trimming reads both.
			if (line.trim() === delimiter) {
				break;
			}
		}
	}
	return cursor;
}

/**
 * Splits the command into segments and words.
 *
 * Quote state is tracked, so a separator inside quotes is data and not
 * structure: a commit message that quotes `;` or `&&` belongs to the action
 * it was written for, and reading it as structure would lose that action.
 * Quote awareness is also what separates a git token that is DATA
 * (`echo "git push origin main"`) from a live invocation — without it the
 * ceiling has no way to stand.
 */
function lex(command: string): LexResult {
	const segments: Segment[] = [];
	let tokens: Token[] = [];
	let current: Token | undefined;
	let grouped = false;
	let state: "none" | "single" | "double" = "none";
	const pendingHeredocs: string[] = [];

	const open = (): Token => {
		if (current === undefined) {
			current = newToken();
		}
		return current;
	};
	const endWord = (): void => {
		if (current !== undefined) {
			tokens.push(current);
			current = undefined;
		}
	};
	const endSegment = (): void => {
		endWord();
		if (tokens.length > 0) {
			segments.push({ tokens });
			tokens = [];
		}
	};

	let index = 0;
	while (index < command.length) {
		const char = command[index];
		if (state === "single") {
			if (char === "'") {
				state = "none";
				index += 1;
				continue;
			}
			open().value += char;
			index += 1;
			continue;
		}
		if (state === "double") {
			if (char === '"') {
				state = "none";
				index += 1;
				continue;
			}
			if (char === "\\") {
				const next = command[index + 1];
				if (next === "\n") {
					// A line continuation is REMOVED by the shell, inside double
					// quotes as outside them. Carrying the newline into the word
					// leaves a word that matches nothing.
					index += 2;
					continue;
				}
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					open().value += next;
					index += 2;
					continue;
				}
				open().value += char;
				index += 1;
				continue;
			}
			if (char === "$" && command[index + 1] === "(") {
				index = consumeSubstitution(command, index, open());
				continue;
			}
			if (char === "`") {
				index = consumeBacktick(command, index, open());
				continue;
			}
			if (char === "$") {
				open().expansion = true;
			}
			open().value += char;
			index += 1;
			continue;
		}
		if (char === "'") {
			open().quoted = true;
			state = "single";
			index += 1;
			continue;
		}
		if (char === '"') {
			open().quoted = true;
			state = "double";
			index += 1;
			continue;
		}
		if (char === "\\") {
			const next = command[index + 1];
			if (next === "\n") {
				// The shell removes a backslash-newline pair before a word is
				// formed, so `git \<newline> push` IS `git push` and fixes its
				// target exactly as the one-line spelling does.
				index += 2;
				continue;
			}
			if (next !== undefined) {
				open().value += next;
				index += 2;
				continue;
			}
			index += 1;
			continue;
		}
		if (char === "$" && command[index + 1] === "(") {
			index = consumeSubstitution(command, index, open());
			continue;
		}
		if (char === "$" && command[index + 1] === "{") {
			index = consumeBraceExpansion(command, index, open());
			continue;
		}
		if (char === "`") {
			index = consumeBacktick(command, index, open());
			continue;
		}
		if (char === "$") {
			open().expansion = true;
			open().value += char;
			index += 1;
			continue;
		}
		if (char === "#" && current === undefined) {
			// A `#` that BEGINS a word begins a comment, and a comment runs to the
			// end of its line. Mid-word it is an ordinary character — a ref may be
			// spelled with one — and inside quotes it is data, which is why this
			// test sits in the lexer's unquoted state and asks where the word
			// starts rather than where the character is.
			while (index < command.length && command[index] !== "\n") {
				index += 1;
			}
			continue;
		}
		if (char === "<" && command[index + 1] === "<") {
			const afterOperator = command[index + 2] === "-" ? index + 3 : index + 2;
			const { delimiter, end } = readHeredocDelimiter(command, afterOperator);
			// The operator ends the word before it, exactly as any redirection
			// does, and the operator itself is not one of the action's words.
			endWord();
			pendingHeredocs.push(delimiter);
			index = end;
			continue;
		}
		if (char === ">" || char === "<") {
			// A redirection operator ends the word before it, so a redirection
			// fused to a subcommand (`git commit>out`) cannot survive as one
			// token. An all-digit word before it is the IO number the operator
			// takes, and stays attached — without that, `2>/dev/null git push`
			// reads as a program named `2`.
			if (current !== undefined && !/^[0-9]*[<>]*$/.test(current.value)) {
				endWord();
			}
			open().value += char;
			index += 1;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			endWord();
			index += 1;
			continue;
		}
		if (char === "\n" || char === ";") {
			endSegment();
			index += 1;
			if (char === "\n" && pendingHeredocs.length > 0) {
				index = skipHeredocBodies(command, index, pendingHeredocs);
				pendingHeredocs.length = 0;
			}
			continue;
		}
		if (char === "&" || char === "|") {
			endSegment();
			index += command[index + 1] === char ? 2 : 1;
			continue;
		}
		if (char === "(" || char === ")" || char === "{" || char === "}") {
			grouped = true;
			endSegment();
			index += 1;
			continue;
		}
		open().value += char;
		index += 1;
	}

	if (state !== "none") {
		return { ok: false, why: "an unbalanced quote leaves the command's structure unread" };
	}
	endSegment();
	return { ok: true, lexed: { segments, grouped } };
}

/** True when a word carries a redirection operator rather than an argument. */
function isRedirection(token: Token): boolean {
	return !token.quoted && /^[0-9]*(?:>>|>|<)/.test(token.value);
}

/** True when the redirection word is the operator alone, so its target follows. */
function isBareRedirection(token: Token): boolean {
	return !token.quoted && /^[0-9]*(?:>>|>|<)$/.test(token.value);
}

/** Drops redirections and their targets: they are not the action's arguments. */
function withoutRedirections(tokens: Token[]): Token[] {
	const kept: Token[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (isRedirection(token)) {
			index += isBareRedirection(token) ? 2 : 1;
			continue;
		}
		kept.push(token);
		index += 1;
	}
	return kept;
}

/** What one segment turned out to be. */
type SegmentReading =
	/** Resolved, and it advances no ref: the only shape that earns a `none`. */
	| { kind: "accounted" }
	/** Resolved, and it moves the shell's directory before anything else runs. */
	| { kind: "directory-change" }
	| { kind: "target"; action: "commit" | "push"; refSpec: string | null }
	/** Resolved, and the string does not fix the target. */
	| { kind: "undecidable"; why: string }
	/** NOT resolved: the reading cannot say what this segment runs. */
	| { kind: "unattributable"; why: string };

/** What a `git …` invocation turned out to be. */
type GitReading =
	| { kind: "accounted" }
	| { kind: "target"; action: "commit" | "push"; refSpec: string | null }
	| { kind: "undecidable"; why: string };

/** Reads one push invocation's arguments into at most one refspec. */
function readPushRefSpec(args: Token[]): GitReading {
	const positional: Token[] = [];
	let index = 0;
	while (index < args.length) {
		const token = args[index];
		const word = token.value;
		if (word.startsWith("-") && word !== "-") {
			const flagName = word.split("=")[0];
			if (WHOLE_REPOSITORY_PUSH_FLAGS.has(flagName)) {
				return {
					kind: "undecidable",
					why: `\`${flagName}\` pushes a whole-repository ref set that no single refspec names`,
				};
			}
			if (INERT_PUSH_FLAGS.has(word) || flagName === "--force-with-lease" || flagName === "--recurse-submodules") {
				index += 1;
				continue;
			}
			return { kind: "undecidable", why: `an unrecognised push option (\`${flagName}\`) leaves the target unread` };
		}
		positional.push(token);
		index += 1;
	}
	if (positional.length === 0) {
		// A bare push: the string leaves the target to configuration, which is
		// a resolution the gate performs — not an unread one.
		return { kind: "target", action: "push", refSpec: null };
	}
	if (positional.length === 1) {
		return { kind: "target", action: "push", refSpec: null };
	}
	if (positional.length > 2) {
		return { kind: "undecidable", why: "more than one refspec: the command names a target set, not a target" };
	}
	const refSpec = positional[1];
	if (refSpec.expansion || refSpec.substitution) {
		return { kind: "undecidable", why: "the refspec is assembled at run time, so the string does not name it" };
	}
	return { kind: "target", action: "push", refSpec: refSpec.value };
}

/** The name the shell would execute for a word — its last path component. */
function executedName(token: Token | undefined): string {
	const parts = (token?.value ?? "").split("/");
	return parts[parts.length - 1] ?? "";
}

/**
 * True when this word's own arguments carry the program TEXT, rather than
 * the name of a program the reading cannot open.
 *
 * The discriminator is presence, never the interpreter's name: `bash -lc "…"`
 * carries its program here in this string, `bash deploy.sh` carries a name.
 * The interpreter named by a path is the same interpreter, which is why the
 * name compared is the executed one and not the word as written.
 */
function carriesProgramText(name: string, tokens: Token[]): boolean {
	if (PROGRAM_TEXT_WORDS.has(name)) {
		return tokens.length > 1;
	}
	if (!SHELL_WORDS.has(name)) {
		return false;
	}
	return tokens.slice(1).some((token) => PROGRAM_TEXT_FLAG.test(token.value));
}

/**
 * The first word past a launcher that the reading recognises as deciding
 * something — a literal `git`, or a word that moves the working directory.
 *
 * A launcher's own options are not enumerable, so the reading looks for the
 * words it can attribute rather than trying to count arguments. Nothing
 * recognised means the launcher runs an ordinary program, which is the
 * `unknown-launcher-target` residual.
 */
function consequentialWordAfterLauncher(tokens: Token[]): number {
	for (let index = 1; index < tokens.length; index += 1) {
		const name = executedName(tokens[index]);
		if (name === "git" || DIRECTORY_CHANGING_WORDS.has(name)) {
			return index;
		}
	}
	return -1;
}

/** The command word the shell would execute, or why the reading cannot say. */
type HeadResolution =
	| { kind: "resolved"; tokens: Token[]; redirectedBy: string | undefined }
	| { kind: "empty" }
	| { kind: "unattributable"; why: string };

/**
 * The words left once the shell's own prefix is gone, and whether that
 * prefix moved git's subject.
 *
 * A command word is not the first token of a string. An assignment prefix,
 * a compound statement's keyword and a launcher word all sit in front of
 * the word that decides what runs, and reading the first token as the
 * command name answers about the prefix instead of about the action behind
 * it. The assignments are inspected rather than merely skipped: `GIT_DIR=…`
 * moves the invocation to another repository exactly as `--git-dir=…` does,
 * and one spelling may not be more permissive than the other (§3.11).
 *
 * Every exit that is not `resolved` leaves the segment unaccounted for, and
 * the default above decides what that means.
 */
function resolveHead(segmentTokens: Token[]): HeadResolution {
	let tokens = withoutRedirections(segmentTokens);
	let redirectedBy: string | undefined;
	// Each turn of this loop drops at least one word, so it terminates.
	for (;;) {
		let index = 0;
		while (index < tokens.length) {
			const token = tokens[index];
			if (!token.quoted && RESERVED_WORDS.has(token.value)) {
				index += 1;
				continue;
			}
			const assignment = token.quoted ? null : ASSIGNMENT_WORD.exec(token.value);
			if (assignment !== null) {
				if (REDIRECTING_ASSIGNMENTS.has(assignment[1])) {
					redirectedBy = assignment[1];
				}
				index += 1;
				continue;
			}
			break;
		}
		tokens = tokens.slice(index);
		if (tokens.length === 0) {
			return { kind: "empty" };
		}
		const head = tokens[0];
		if (head.expansion || head.substitution) {
			return {
				kind: "unattributable",
				why: "the program in command position is assembled at run time, so the string does not name what runs",
			};
		}
		const name = executedName(head);
		if (carriesProgramText(name, tokens)) {
			return {
				kind: "unattributable",
				why: "the program handed to an interpreter is text this reading does not open",
			};
		}
		if (!LAUNCHER_WORDS.has(name)) {
			return { kind: "resolved", tokens, redirectedBy };
		}
		const position = consequentialWordAfterLauncher(tokens);
		if (position === -1) {
			// The launcher runs a program the reading does not recognise, which is
			// an ordinary program as far as this string says.
			return { kind: "resolved", tokens, redirectedBy };
		}
		for (const skipped of tokens.slice(1, position)) {
			const assignment = skipped.quoted ? null : ASSIGNMENT_WORD.exec(skipped.value);
			if (assignment !== null && REDIRECTING_ASSIGNMENTS.has(assignment[1])) {
				redirectedBy = assignment[1];
			}
		}
		tokens = tokens.slice(position);
	}
}

/** Reads a `git …` invocation whose command word is already known to be git. */
function readGitInvocation(tokens: Token[]): GitReading {
	let index = 1;
	while (index < tokens.length) {
		const word = tokens[index].value;
		if (!word.startsWith("-") || word === "-") {
			break;
		}
		const flagName = word.split("=")[0];
		if (REDIRECTING_GLOBAL_OPTIONS.includes(flagName)) {
			return {
				kind: "undecidable",
				why: `\`${flagName}\` redirects the invocation, so the repository the verdict was taken against is not the one the action runs in`,
			};
		}
		if (INERT_GLOBAL_OPTIONS.has(word)) {
			index += 1;
			continue;
		}
		return { kind: "undecidable", why: `an unrecognised git option (\`${flagName}\`) before the subcommand` };
	}
	const token = tokens[index];
	if (token !== undefined && (token.expansion || token.substitution)) {
		// The word that decides the action is assembled at run time, so the
		// string does not name the action, let alone its target (§3.9).
		return { kind: "undecidable", why: "the git subcommand is assembled at run time, so the string does not name it" };
	}
	const subcommand = token?.value;
	if (subcommand === undefined || !GUARDED_SUBCOMMANDS.has(subcommand)) {
		return { kind: "accounted" };
	}
	if (subcommand === "commit") {
		return { kind: "target", action: "commit", refSpec: null };
	}
	return readPushRefSpec(tokens.slice(index + 1));
}

/**
 * Reads one segment into what the reading can account for.
 *
 * The order is the point. Redirections are removed and the head is resolved
 * BEFORE anything asks what the command word is, because every one of those
 * forms can stand where the command word is read. What the head resolution
 * could not attribute stays unattributed here: `accounted` is an
 * affirmative "this segment advances no ref", and a segment whose command
 * word the reading never resolved has not established that (§3.9).
 */
function readSegment(segment: Segment): SegmentReading {
	const head = resolveHead(segment.tokens);
	if (head.kind === "empty") {
		return { kind: "accounted" };
	}
	if (head.kind === "unattributable") {
		return head;
	}
	const name = executedName(head.tokens[0]);
	if (DIRECTORY_CHANGING_WORDS.has(name)) {
		return { kind: "directory-change" };
	}
	if (name !== "git") {
		// An ordinary program, and no git invocation is attributable to this
		// segment: the reading has accounted for it.
		return { kind: "accounted" };
	}
	const reading = readGitInvocation(head.tokens);
	if (head.redirectedBy !== undefined && reading.kind === "target") {
		return {
			kind: "undecidable",
			why: `\`${head.redirectedBy}\` redirects the invocation, so the repository the verdict was taken against is not the one the action runs in`,
		};
	}
	return reading;
}

/** True when any word the command carries spells a guarded subcommand. */
function mentionsGuardedSubcommand(segments: Segment[]): boolean {
	return segments.some((segment) => segment.tokens.some((token) => GUARDED_SUBCOMMAND_MENTION.test(token.value)));
}

/** Reads `command` into exactly one of the three values. Never throws. */
export function parseGitCommand(command: string): ParsedCommand {
	const result = lex(command);
	if (!result.ok) {
		return { kind: "undecidable", why: result.why };
	}
	const { segments, grouped } = result.lexed;

	const targets: Array<{ action: "commit" | "push"; refSpec: string | null }> = [];
	let unattributable: string | undefined;
	let directoryChange = false;
	for (const segment of segments) {
		const reading = readSegment(segment);
		if (reading.kind === "undecidable") {
			return reading;
		}
		if (reading.kind === "unattributable") {
			unattributable ??= reading.why;
			continue;
		}
		if (reading.kind === "directory-change") {
			directoryChange = true;
			continue;
		}
		if (reading.kind === "target") {
			targets.push({ action: reading.action, refSpec: reading.refSpec });
		}
	}

	// THE DEFAULT. A segment the reading could not attribute, in a command
	// that carries a guarded subcommand word, is not something `none` may be
	// claimed about — whatever shape it was written in, and whether or not
	// anything here has a rule for that shape.
	if (unattributable !== undefined && mentionsGuardedSubcommand(segments)) {
		return { kind: "undecidable", why: unattributable };
	}

	if (targets.length === 0) {
		// Nothing here advances a ref: an unattributed segment carrying no
		// guarded subcommand word, a directory change on its own, or ordinary
		// work. None of it is refused for existing (§3.6).
		return { kind: "none" };
	}
	if (directoryChange) {
		return {
			kind: "undecidable",
			why: "the command changes directory, so the action's repository is not the one the verdict was taken against",
		};
	}
	for (const segment of segments) {
		for (const token of segment.tokens) {
			if (token.substitution) {
				return { kind: "undecidable", why: "a command substitution stands between the string and the action" };
			}
		}
	}
	if (grouped) {
		return { kind: "undecidable", why: "the command groups its segments, so their order and context are not linear" };
	}
	const [first] = targets;
	for (const target of targets) {
		if (target.action !== first.action || target.refSpec !== first.refSpec) {
			return { kind: "undecidable", why: "the command carries more than one guarded action" };
		}
	}
	return { kind: "target", action: first.action, refSpec: first.refSpec };
}
