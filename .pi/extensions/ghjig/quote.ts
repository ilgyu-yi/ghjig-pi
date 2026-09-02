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
 *     the ESC byte becomes the six characters backslash-u001b, so no
 *     component can start a line of its own or land a control byte on
 *     the operator's terminal — the standard the record write already
 *     meets at the sink (§5.5: any free text encoded at write time);
 *   - it DELIMITS: the quotes mark the value's exact extent, for the
 *     operator pasting a recovery act into a shell and for the suite's
 *     clause reader alike — whitespace inside the value no longer reads
 *     as the value's end.
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
	return JSON.stringify(value);
}
