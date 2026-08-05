/**
 * Truncate with an ellipsis, or return the value unchanged when it fits.
 *
 * Lives in `lib/` because it is pure and CLIENT-SAFE, and three unrelated
 * layers now need it: the role-sheet PDF layout, the minutes PDF, and the
 * speaker-detail write caps in [[speaker-limits]]. That last one is why it
 * moved here from `server/role-sheet-layout.ts` — `speaker-limits.ts` runs on
 * both sides of the wire, and importing a `@react-pdf/renderer` module into it
 * would drag the whole PDF stack into the browser bundle.
 *
 * `role-sheet-layout.ts` re-exports this so its existing callers (including
 * `renderRoleSheetPdf`, which caps the download FILENAME without going through
 * `capFill`) keep working unchanged.
 *
 * Bounds CODE POINTS, not UTF-16 code units, so the output is at most `max`
 * code points and never more than `2 * max` units. Slicing by unit would cut a
 * surrogate pair in half and emit a lone surrogate, which react-pdf renders as
 * a tombstone glyph and which is invalid in a PDF text string.
 */
export function cap(value: string, max: number): string {
	// Cost must scale with `max`, NOT with the input. The first version of this
	// spread the whole string (`[...value]`) before deciding whether to truncate,
	// which recreated the exact DoS this function exists to stop: 8MB of speech
	// title cost 473ms and tens of MB of heap per unauthenticated GET, for a
	// 160-char output. Found by the adversarial pass on #519.
	//
	// Two bounds do it. A UTF-16 `.length` is always >= the code-point count, so
	// a value that fits by that measure fits by any, and returns untouched with
	// no allocation. Otherwise spread only a PREFIX: a code point is at most two
	// UTF-16 units, so `max * 2` units always contains at least `max` code
	// points — enough to slice from, and bounded.
	if (value.length <= max) return value;
	const points = [...value.slice(0, max * 2)];
	// BOTH clauses are load-bearing, and the `value.length <= max * 2` one was
	// missing until #522's review. `points` describes only the PREFIX, so
	// `points.length <= max` alone does not mean the WHOLE value fits — for an
	// all-astral string the prefix holds exactly `max` code points no matter how
	// long the value is, and returning `value` there handed the renderer the
	// entire input. Measured: `cap("😀".repeat(100_000), 200)` returned all
	// 200,000 units, and a 20,000-emoji club name cost 7,848ms of blocked event
	// loop on the PUBLIC unauthenticated role-sheets GET, against 156ms for the
	// same length in ASCII.
	//
	// Past `max * 2` units the value cannot fit in `max` code points (a code
	// point is at most two units), so it must be truncated. At or below it, the
	// prefix IS the whole value and `points` describes it exactly.
	if (value.length <= max * 2 && points.length <= max) return value;
	return `${points.slice(0, max - 1).join("")}…`;
}
