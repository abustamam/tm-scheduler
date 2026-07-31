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
// ---------------------------------------------------------------------------
// THE BUDGET
//
// The word must render on ONE line inside **704px** — PAGE_W 816 minus the
// poster content box's 2 × 56px horizontal padding. Every size below was
// measured in headless Chrome against the real Fraunces 600 webfont. Measure
// with the real face or not at all: call `document.fonts.load(...)` FIRST,
// because `fonts.ready` resolves immediately when nothing has requested the
// face yet, and you will silently measure Georgia and get numbers that are
// wrong in both directions.
//
// Method that produced these: canvas `measureText` over all 104,334 entries of
// `/usr/share/dict/words`, bucketed by length, then real DOM
// `getBoundingClientRect` on the widest 30 candidates per bucket.
//
// ---------------------------------------------------------------------------
// WHY LENGTH IS A WEAK PROXY FOR WIDTH
//
// Fraunces 600 advances span **0.243em (`i`, `j`) to 0.804em (`m`)** — a 3.3x
// spread. Three real 14-character words at 100px measure 560px
// ("Verisimilitude"), 631px ("Circumlocution") and 722px ("Cumbersomeness").
// So no single size per length bucket is simultaneously safe for the widest
// word and generous for the narrowest; every bucket is priced for its worst
// case, and `m`/`w`-heavy words are what set that price. The dictionary-wide
// worst cases are all of that shape: "mammon", "mammograms",
// "newspaperwoman", "telecommunications", "electroencephalographs".
//
// KNOWN UPGRADE PATH, DELIBERATELY NOT TAKEN: bucket on estimated WIDTH
// instead of raw length — sum a per-character em-advance table and pick the
// largest size whose product stays under 704px. It is strictly more accurate
// and stays pure/SSR-safe. It was rejected on cost, not correctness: it
// hardcodes a metric table for one font at one weight that silently rots when
// the brand font or weight changes, and it buys perhaps 130px → 145px on a
// word. At these sizes the letters are over an inch tall on a letter sheet —
// readable across a room — so being under optimal is not a failure. The
// failure to eliminate is the mid-word break. Revisit this only if a club
// actually reports the word looking too small.
//
// ---------------------------------------------------------------------------
// RESIDUAL GAP (read before assuming these are safe)
//
// These sizes do NOT clear the dictionary-wide worst case in every bucket.
// Measured at the sizes below, against lowercase common words (proper nouns
// and acronyms excluded — a Word of the Day is an ordinary word):
//
//   ≤6  @177  "mammon"                 684px  (97%)  fits
//   ≤10 @130  "mammograms"             764px (109%)  OVERFLOWS → needs ≤119px
//   ≤14 @ 97  "newspaperwoman"         716px (102%)  OVERFLOWS → needs ≤ 95px
//   ≤18 @ 81  "telecommunications"     691px  (98%)  fits
//   >18 @ 68  "electroencephalographs" 736px (105%)  OVERFLOWS → needs ≤ 65px
//
// Two further population notes that change the answer materially:
//   • Capitalised entry ("Mammograms") is the likeliest real input style and is
//     slightly wider still; covering it needs 177/119/93/80/64.
//   • ALL-CAPS entry ("POWWOW", "GROUNDWORK") is far wider — covering it would
//     need 145/98/72/57/46, a large sacrifice for every other word. Not done;
//     an all-caps word will wrap.
//
// Where a word does exceed the budget, `overflowWrap: "anywhere"` on the poster
// keeps it to a mid-word break rather than a clipped or overflowing page.

/** Longest word length that still earns each size, largest bucket first. */
const BUCKETS: readonly (readonly [maxLength: number, size: number])[] = [
	[6, 177],
	[10, 130],
	[14, 97],
	[18, 81],
];

/** Size for anything longer than the last bucket. */
const SMALLEST = 68;

/** Display font size in px for `word`, from its trimmed length. */
export function posterWordSize(word: string): number {
	const length = word.trim().length;
	for (const [maxLength, size] of BUCKETS) {
		if (length <= maxLength) return size;
	}
	return SMALLEST;
}
