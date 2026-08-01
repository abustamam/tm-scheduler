/**
 * Comment-blind source reading for the `*.guard.test.ts` source greps.
 *
 * ## Why this exists
 *
 * Several guards in this repo assert on raw file TEXT, because the thing they
 * protect has no behavioural test surface (print CSS, a `createServerFn`
 * wrapper, coverage of a route SET). Every one of those guards has the same
 * structural hole: a file that merely MENTIONS the required pattern in a
 * COMMENT satisfies the assertion exactly as well as the real code does, so the
 * real code becomes deletable with the guard still green.
 *
 * That is not hypothetical. `public-disclaimer.guard.test.ts` greps each public
 * club route for `<PublicFooter />`; while the Word of the Day poster route was
 * being added, a comment on that route explaining its footer contained the
 * literal string `<PublicFooter />`, and the guard kept passing after the real
 * element was removed. A mutation check (delete the element, keep the comment)
 * is what surfaced it. Reading through here makes that bypass structurally
 * impossible instead of asking every future author to remember.
 *
 * ## Which guards should use this, and which must not
 *
 * Only guards of the form "this pattern must BE present". For those, a comment
 * causes a false PASS — a real bypass.
 *
 * Guards of the opposite form — "the offender list must be empty"
 * (`ti-wordmark.guard.test.ts`, `server-modules.guard.test.ts`) — must NOT read
 * through here. There, a comment can only produce a false FAILURE, so stripping
 * would LOOSEN them. Both carry a note at their source read saying so.
 *
 * ## Why comments are blanked rather than removed
 *
 * Comments are replaced with spaces and their newlines are preserved, so the
 * output is byte-for-byte the same LENGTH as the input and every line number
 * and character offset stays true. Guards do line-based and offset-based work —
 * `split("\n")`, `indexOf("</AppShell>")`, brace-matching an `@media print {…}`
 * block — and a stripper that deleted comments outright would shift every
 * offset after the first block comment and silently move what those guards
 * actually inspect.
 *
 * Blanking a comment that contains an unbalanced `}` also fixes a second latent
 * bug in the brace-matching guards, where such a comment could end a block early.
 *
 * ## Honest limitation
 *
 * This is a lexical pass, not a parser. It does not track string or template
 * literals or regex literals, so a comment-opening sequence inside one of those
 * is also blanked. That can only remove text a guard might have matched — it can
 * make a "must be present" guard stricter (a false failure a human sees
 * immediately), never weaker. A false failure is the safe direction for a guard;
 * a false pass is the failure mode this module exists to close.
 */
import { readFileSync } from "node:fs";

/**
 * Comments, matched in ONE left-to-right alternation so whichever construct
 * opens FIRST wins: a block opener sitting inside a line comment is part of
 * that line comment, and a line opener sitting inside a block comment is part
 * of that block. Two sequential `.replace()` passes get one of those backwards
 * and can eat live code past the end of a comment.
 *
 * The `(?<!:)` on the line-comment arm keeps `https://example.com` intact — a
 * URL's slashes are preceded by a colon and are not a comment.
 */
const COMMENT = /\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g;

/** Same length, same newlines, no content. */
const blank = (match: string) => match.replace(/[^\n]/g, " ");

/**
 * Replace every JS/TS comment with spaces, preserving length and newlines so
 * line numbers and character offsets are unchanged.
 */
export function stripComments(source: string): string {
	return source.replace(COMMENT, blank);
}

/** `readFileSync` + {@link stripComments}. The normal entry point for a guard. */
export function readSource(path: string): string {
	return stripComments(readFileSync(path, "utf8"));
}
