// src/lib/word-poster.ts
//
// Display sizing for the Word of the Day poster
// (`components/agenda/word-of-the-day-poster.tsx`). "Apt" and
// "obstreperousness" cannot share a font size, and the poster's whole job is to
// be readable from the back of the room, so the word is sized from its length.
//
// Deterministic buckets rather than a measure-and-scale pass: this runs during
// SSR, needs no DOM, and is unit-testable. The poster also sets `overflowWrap`
// as a backstop for anything longer than the last bucket anticipates.
//
// THESE SIZES WERE MEASURED, NOT GUESSED — but they are a partial fix, and the
// model underneath them is known to be wrong. Read this before retuning.
//
// Measurement setup: headless Chrome, the real Fraunces 600 webfont (NOT a
// fallback face — the metrics differ substantially), against the poster's
// usable content width of **704px** (PAGE_W 816 minus the content box's
// 2 × 56px horizontal padding). A word "fits" when its natural single-line
// width stays under 704px.
//
// The original sizes (200/150/112/88/68) were estimated from a ~0.5em average
// advance and overflowed on ordinary words — "Wholesome", a plain 9-letter
// word, rendered 711px at 150px and broke mid-word. These lowered sizes fix
// the ≤18 and ≤24 buckets outright and shrink the overflow elsewhere.
//
// KNOWN REMAINING DEFECT: three buckets still overflow for wide-letter words.
// Measured worst real words at the sizes below:
//   ≤6  @190  "Wampum"         752px (107%)  → would need ≤177px
//   ≤10 @145  "Cumbersome"     784px (111%)  → would need ≤130px
//   ≤14 @100  "Cumbersomeness" 722px (103%)  → would need ≤ 97px
//   ≤18 @ 80  "Unceremoniousness" 688px (98%)  fits
//   >18 @ 64  "Uncommunicativeness" 658px (93%) fits
//
// The root cause is structural, not a bad constant: **length is a poor proxy
// for width.** Fraunces 600 advances range from i/j at 0.243em to m at
// 0.804em — a 3.3x spread. Three real 14-character words at 100px measure
// 560px ("Verisimilitude"), 631px ("Circumlocution") and 722px
// ("Cumbersomeness"). No single size per length bucket can be both safe for
// the widest word and generous for the narrowest; shaving further to cover
// "Cumbersome" would render "Verisimilitude" far smaller than it needs to be.
//
// The durable fix is to bucket on ESTIMATED WIDTH rather than raw length — sum
// a per-character em-advance table and pick the largest size whose product
// stays under 704px. That stays pure, SSR-safe and unit-testable. Until then,
// `overflowWrap: "anywhere"` on the poster keeps an overflow to an ugly
// mid-word break rather than a clipped page.
//
// To re-derive after a font, PAGE_W, or padding change: render each bucket's
// worst-case word at the candidate size in a real browser with Fraunces loaded
// (call `document.fonts.load(...)` FIRST — `fonts.ready` resolves immediately
// when nothing has requested the face yet, and you will silently measure
// Georgia and get numbers that are wrong in both directions).

/** Longest word length that still earns each size, largest bucket first. */
const BUCKETS: readonly (readonly [maxLength: number, size: number])[] = [
	[6, 190],
	[10, 145],
	[14, 100],
	[18, 80],
];

/** Size for anything longer than the last bucket. */
const SMALLEST = 64;

/** Display font size in px for `word`, from its trimmed length. */
export function posterWordSize(word: string): number {
	const length = word.trim().length;
	for (const [maxLength, size] of BUCKETS) {
		if (length <= maxLength) return size;
	}
	return SMALLEST;
}
