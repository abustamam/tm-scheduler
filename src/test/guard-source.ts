/**
 * Shared source-reading for the `*.guard.test.ts` source greps: comment-blind
 * reads, and the `createServerFn` declaration slicer those sweeps classify.
 *
 * Two things live here, and they have different jobs. {@link stripComments} /
 * {@link readSource} decide WHAT TEXT a guard sees; {@link serverFnDeclarations}
 * / {@link serverFnBody} decide WHICH TEXT belongs to which declaration. The
 * slicer moved here from `public-readers-archive-gate.guard.test.ts` in #761,
 * when `write-proof.guard.test.ts` became a second consumer — its own reasoning
 * is on the function, and `guard-source.test.ts` beside this file is its
 * self-test.
 *
 * ## Why comment-blind reading exists
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

/**
 * The top-level declaration a slice must stop at.
 *
 * Exported because two guards slice against it: this module's
 * {@link serverFnDeclarations}, and `public-readers-archive-gate.guard.test.ts`'s
 * own `namedFunctionBody`, which slices `export async function` declarations the
 * same way.
 */
export const TOP_LEVEL_BOUNDARY =
	/^(?:\/\*\*|\/\/|export |const |let |var |function |async function |class |type |interface |enum |declare )/;

/** One `export const <name> = createServerFn(…)` declaration. */
export interface ServerFnDeclaration {
	name: string;
	/** `"GET"` or `"POST"`, read out of the sliced BODY — or `"UNKNOWN"` when the
	 *  declaration names no method. Never absent: a declaration that drops out of
	 *  the list is invisible to every sweep built on it, so an unreadable method
	 *  has to arrive as a value a caller can fail on. */
	method: string;
	/** The declaration's text, from its `export const` to the next top-level one. */
	body: string;
}

/**
 * Every `createServerFn` declaration in one module, each sliced from its own
 * `export const` to the next TOP-LEVEL declaration (or EOF).
 *
 * Lived in `public-readers-archive-gate.guard.test.ts` until #761 needed the
 * same slices for `write-proof.guard.test.ts`. Both guards now import it, and
 * `guard-source.test.ts` beside this file holds the self-test that proves the
 * slicing, so the property is pinned once rather than per consumer.
 *
 * ## Why statement-scoped, and why THIS boundary
 *
 * Statement-scoped rather than whole-file on purpose: `meetings.ts` holds both
 * the public key readers AND authed fns that legitimately call the ungated
 * `resolveMeetingKey`, so a whole-file "must not contain" assertion would be
 * unsatisfiable and a whole-file "must contain" one would be satisfied by a
 * DIFFERENT function's correct call.
 *
 * Two earlier attempts were each wrong in one direction. Slicing to the next
 * `export` over-captured every non-exported declaration in between plus the
 * following export's JSDoc — `listUpcomingMeetings` absorbed
 * `const pastMeetingsInput = …`, `getMeetingByKey` absorbed
 * `getPublicMeetingByKey`'s doc comment. Slicing to a literal `\n});` then
 * over-captured in a way nobody could see (#565): every `createServerFn` closes
 * at ONE TAB (`\t});`) because `.handler(` is chained one level in, so that
 * pattern never matched a declaration's own terminator. It matched the next
 * column-0 `});` — usually a later `z.object({…})` — and the slice ran straight
 * through whatever sat between.
 *
 * That is not a tidiness problem. Both consuming guards classify a fn by what
 * its slice CONTAINS, so a swallowed neighbour LENDS its `require*` call to the
 * fn being classified: `getMinutes` absorbed `gateAdmin`, matched THAT
 * function's `requireUser`, and was filed as session-guarded and skipped by the
 * archive sweep — which is how the #560 minutes leak reached production behind
 * 54/54 green. Measured across `src/server` at the time of the fix: 40 of 162
 * slices over-captured, one of them by 11,000 characters.
 *
 * ## Match the DECLARATION, then read the method out of the body
 *
 * Not `createServerFn\(\{\s*method:\s*"(\w+)"`, which pins `method` as the FIRST
 * key. `officer-training-authz.guard.test.ts` removed exactly that regex for
 * exactly this reason, and #761's review measured the same hole here:
 * `createServerFn({ response: "raw", method: "POST" })` and a bare
 * `createServerFn()` both vanish from the list — silently unenrolled, with every
 * per-file floor still satisfied by their neighbours. An enrolment sweep that a
 * declaration STYLE can escape is not a sweep, and the escape is invisible: both
 * consuming guards stay green while the fn is gone.
 *
 * So the declaration is matched on its own (the same shape
 * `public-readers-archive-gate.guard.test.ts` used before #761 moved this here,
 * so its candidate set did not narrow), and the method is read from the slice.
 * A declaration naming no method reports `"UNKNOWN"` rather than disappearing;
 * `guard-source.test.ts` fails on one, and a method filter downstream must treat
 * anything that is not `"GET"` as a candidate rather than skipping what it
 * cannot read.
 *
 * ## Reading mode is the CALLER's choice
 *
 * This takes a source STRING, not a path, because the two assertion classes in
 * this module's own rule need opposite readers and both slice. Pass
 * {@link readSource} output for a "must BE present" assertion and raw
 * `readFileSync` for an offender sweep.
 */
export function serverFnDeclarations(source: string): ServerFnDeclaration[] {
	const out: ServerFnDeclaration[] = [];
	for (const m of source.matchAll(/^export const (\w+) = createServerFn/gm)) {
		const body = sliceDeclaration(source, m.index ?? 0);
		out.push({
			name: m[1] as string,
			method: /method:\s*"(\w+)"/.exec(body)?.[1] ?? "UNKNOWN",
			body,
		});
	}
	return out;
}

/**
 * The body of ONE named `createServerFn` declaration.
 *
 * Throws when the name is absent rather than returning `""`: a guard keyed on a
 * name that was renamed or removed must be re-pointed, not silently satisfied
 * by an empty slice.
 */
export function serverFnBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	return sliceDeclaration(source, start);
}

/** Slice from `start` to the line that begins the next top-level declaration. */
function sliceDeclaration(source: string, start: number): string {
	const lines = source.slice(start).split("\n");
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		// i > 0 skips the declaration's own opening line.
		if (i > 0 && TOP_LEVEL_BOUNDARY.test(line)) {
			return source.slice(start, start + offset);
		}
		offset += line.length + 1;
	}
	return source.slice(start);
}
