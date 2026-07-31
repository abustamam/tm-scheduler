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
// There are TWO tables. Capitals run ~20–30% wider than lowercase, so one
// table cannot serve both: at the normal sizes "POWWOW" is 122% of the budget
// and "GROUNDWORK" is 132%, both breaking mid-word. Shrinking the normal table
// far enough to absorb that would tax every ordinary word to pay for a styling
// choice, so all-caps input gets its own smaller table instead.
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
// NEVER EXTRAPOLATE A SIZE — MEASURE AT THE SIZE YOU INTEND TO USE
//
// Fraunces is a VARIABLE font with an optical-size axis (opsz 9..144), and CSS
// `font-optical-sizing` defaults to `auto`. The letterforms therefore change
// shape with font-size, and width is NOT proportional to size: smaller sizes
// render relatively WIDER. "Telecommunications" measures 8.30 px of width per
// px of font-size at 120px, but 9.84 at 46px — an 18% swing.
//
// Consequence: `newSize = size × budget / measuredWidth` is systematically
// optimistic and will leave you just over the line. Three successive retunes
// missed for exactly this reason. To find a size, render at each candidate
// size and take the largest one that fits.
//
// ---------------------------------------------------------------------------
// VERIFIED COVERAGE
//
// Both tables were checked against all 63,993 lowercase common words in
// `/usr/share/dict/words` (proper nouns, acronyms and possessives excluded — a
// Word of the Day is an ordinary word), in each realistic input style. Widest
// word per bucket, all inside the 704px budget:
//
//   NORMAL, lowercase          NORMAL, Capitalised
//   ≤6  @177 mammon      683px   ≤6  @177 Wampum                 700px
//   ≤10 @119 mammograms  700px   ≤10 @119 Mammograms             702px
//   ≤14 @ 93 newspaper…  689px   ≤14 @ 93 Newspaperwoman         703px
//   ≤18 @ 79 telecomms…  684px   ≤18 @ 79 Telecommunications     704px
//   >18 @ 63 electroen…  689px   >18 @ 63 Electroencephalographs 698px
//
//   ALL_CAPS
//   ≤6  @145 POWWOW                 704px
//   ≤10 @ 97 GROUNDWORK             700px
//   ≤14 @ 67 NEWSPAPERWOMAN         695px
//   ≤18 @ 54 CHLOROFLUOROCARBON     702px
//   >18 @ 45 ELECTROENCEPHALOGRAPHS 700px
//
// Several buckets sit within a few px of the budget. That is deliberate — each
// size is the largest that fits — but it means ANY change to PAGE_W, the
// poster's padding, the font, or the weight invalidates the whole table.
//
// Longer-than-dictionary or non-English input can still exceed the budget;
// `overflowWrap: "anywhere"` on the poster keeps that to a mid-word break
// rather than a clipped or overflowing page.

/**
 * A length→size table: buckets largest-first, plus the floor for anything
 * longer than the last bucket.
 */
type SizeTable = {
	buckets: readonly (readonly [maxLength: number, size: number])[];
	smallest: number;
};

/** Ordinary words — lowercase or Capitalised. */
const NORMAL: SizeTable = {
	buckets: [
		[6, 177],
		[10, 119],
		[14, 93],
		[18, 79],
	],
	smallest: 63,
};

/**
 * ALL-CAPS words, which need their own table: capitals run ~20–30% wider than
 * lowercase, so a single table cannot serve both. "POWWOW" is 122% of the
 * budget at the normal ≤6 size and "GROUNDWORK" is 132% at the normal ≤10 size
 * — both would break mid-word. Sizing the normal table down far enough to
 * absorb that would shrink every ordinary word to pay for a styling choice, so
 * the all-caps case gets its own (much smaller) sizes instead and ordinary
 * words pay nothing.
 */
const ALL_CAPS: SizeTable = {
	buckets: [
		[6, 145],
		[10, 97],
		[14, 67],
		[18, 54],
	],
	smallest: 45,
};

/** Shared lookup so the two tables cannot drift apart in behaviour. */
function sizeFrom(table: SizeTable, length: number): number {
	for (const [maxLength, size] of table.buckets) {
		if (length <= maxLength) return size;
	}
	return table.smallest;
}

/**
 * True when the word is written entirely in capitals — it must contain at
 * least one letter, so digit-only input like "1234" falls through to the
 * normal table rather than being sized as shouted text.
 */
function isAllCaps(word: string): boolean {
	return /\p{L}/u.test(word) && word === word.toUpperCase();
}

/** Display font size in px for `word`, from its trimmed length and case. */
export function posterWordSize(word: string): number {
	const trimmed = word.trim();
	return sizeFrom(isAllCaps(trimmed) ? ALL_CAPS : NORMAL, trimmed.length);
}
