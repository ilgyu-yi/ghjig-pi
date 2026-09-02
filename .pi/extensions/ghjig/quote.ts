/**
 * Escaping for actor-influenced text on an operator surface (issue #47).
 *
 * Every warning and refusal these modules emit interpolates a path, and
 * POSIX admits a line break or an escape byte in any path component — so
 * an actor who names a directory can otherwise forge a line INTO the one
 * signal whose job is to say the gate is disarmed (§3.9: a reader must
 * never mistake a disarmed gate for a passing one), or erase that signal
 * from a terminal with the ANSI erase-line sequence. `quoted` is the
 * single spelling every such interpolation goes through, holding a
 * double contract:
 *
 *   - it ESCAPES: a line feed becomes the two characters backslash-n,
 *     the ESC byte becomes the six characters backslash-u001b — and the
 *     classes `JSON.stringify` leaves raw are closed by a post-pass:
 *     DEL and the C1 controls (U+007F–U+009F, holding NEL the line
 *     break and U+009B the one-byte CSI), the LINE/PARAGRAPH
 *     SEPARATORS (U+2028/U+2029), and the bidi controls (U+200E,
 *     U+200F, U+202A–U+202E, U+2066–U+2069) all render as
 *     backslash-u escapes. So no component can start a line of its
 *     own, land a control byte on the operator's terminal, or reorder
 *     how the signal displays — the standard the record write already
 *     meets at the sink (§5.5: any free text encoded at write time);
 *   - it DELIMITS: the quotes mark the value's exact extent, for the
 *     operator pasting a recovery act into a shell and for the suite's
 *     clause reader alike — whitespace inside the value no longer reads
 *     as the value's end. Delimitation is extent-marking only, not
 *     shell-neutralization: dollar, backtick and backslash stay live
 *     inside POSIX double quotes when the value is pasted as-is.
 *
 * One named helper rather than `JSON.stringify` at each site because the
 * structural lock (`test/warning-surface.structure.test.ts`) needs one
 * greppable admit-rule, and because the contract above needs one place to
 * live (§3.10 — uniform mitigation, empty exemption set, structural
 * lock). The hostile bytes are still DISPLAYED, as escaped text: the
 * contract is one line and no control bytes, not concealment.
 */

/** The escaped, quote-delimited rendering of `value` — see the header. */
export function quoted(value: string): string {
	// `JSON.stringify` escapes C0 but emits DEL, the C1 range, the
	// line/paragraph separators and the bidi controls raw (all are valid
	// JSON string content); the post-pass closes those classes. Each
	// escape it emits is itself valid JSON-string syntax, so the output
	// still parses as the JSON string the clause reader decodes.
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
		(raw) => `\\u${raw.codePointAt(0)?.toString(16).padStart(4, "0")}`,
	);
}
