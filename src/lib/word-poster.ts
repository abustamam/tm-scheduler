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
// Two numbers, and the difference between them is deliberate:
//
//   CONTENT_W (704px) = the TRUE content width, PAGE_W minus the poster's
//                       horizontal padding. Exceed it and the word breaks
//                       mid-word. A test pins it to the real values.
//   TARGET_W  (685px) = what every size below was derived against, ~2.7%
//                       narrower.
//
// THE ~19px GAP IS NOT WASTE — DO NOT RECLAIM IT. It is slack for rendering
// variance we cannot measure here. These sizes were derived in one headless
// Chrome on one machine; members print from Chrome, Firefox and Safari across
// platforms, where hinting, subpixel positioning and font-version differences
// each move text width by fractions of a percent. Sizing to exactly CONTENT_W
// would mean betting on zero difference, and an earlier revision of this table
// did exactly that — "POWWOW" landed at 704.0px, 100.0% of budget. Any browser
// rendering a hair wider reintroduces the mid-word break these tables exist to
// prevent. Bumping a size up "because it still fits" spends that insurance.
//
// TWO TABLES, because capitals are far wider — see the `ALL_CAPS` docblock.
//
// To re-derive after any invalidating change, run the harness that produced
// these numbers; do not reconstruct one:
//
//     bun run scripts/measure-word-poster.ts
//
// It reports the widest word and its width per bucket, and will tell you if a
// size no longer clears the target.
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
// largest size whose product stays under the target. It is strictly more
// accurate
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
// size and take the largest whose worst word is ≤ the 685px target.
//
// ---------------------------------------------------------------------------
// VERIFIED COVERAGE
//
// Both tables were checked against all 63,993 lowercase common words in
// `/usr/share/dict/words` (proper nouns, acronyms and possessives excluded — a
// Word of the Day is an ordinary word), in each realistic input style.
//
// The word that BINDS each bucket — i.e. the widest in the dictionary at that
// length, and so the one that set the size. Re-deriving by hand can start from
// these instead of repeating the sweep; the script reports current widths.
//
//   bucket   NORMAL (lowercase / Capitalised)   ALL_CAPS
//   ≤6       mammon / Wampum                    POWWOW
//   ≤10      mammograms                         MAMMOGRAMS
//   ≤14      newspaperwoman                     NEWSPAPERWOMAN
//   ≤18      telecommunications                 CHLOROFLUOROCARBON
//   >18      electroencephalographs             ELECTROENCEPHALOGRAPHS
//
// Each size is the largest that clears the target, so ANY change to PAGE_W,
// POSTER_PAD_X, the font family, or the font weight invalidates both tables
// and they must be re-derived.
//
// Longer-than-dictionary or non-English input can still exceed the budget;
// `overflowWrap: "anywhere"` on the poster keeps that to a mid-word break
// rather than a clipped or overflowing page.

/**
 * The poster content box's horizontal padding, in px. Exported so the poster
 * consumes this exact value rather than repeating a literal: widening the
 * padding narrows the box below the width these sizes were derived against,
 * which would reintroduce mid-word breaks with nothing failing.
 */
export const POSTER_PAD_X = 56;

/**
 * The true usable width, `PAGE_W - 2 * POSTER_PAD_X`. Not derived from
 * `PAGE_W` here because that lives in a React module and this one is
 * deliberately React-free; a unit test asserts the arithmetic instead.
 */
export const CONTENT_W = 704;

/** The width sizes are derived against — CONTENT_W less the safety margin. */
export const TARGET_W = 685;

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
		[6, 173],
		[10, 116],
		[14, 90],
		[18, 74],
	],
	smallest: 61,
};

/**
 * ALL-CAPS words, which need their own table: capitals run ~20–30% wider than
 * lowercase, so a single table cannot serve both. "POWWOW" is 122% of the
 * content width at the normal ≤6 size and "GROUNDWORK" is 132% at the normal
 * ≤10 size — both would break mid-word. Sizing the normal table down far
 * enough to absorb that would shrink every ordinary word to pay for a styling
 * choice, so the all-caps case gets its own (much smaller) sizes instead and
 * ordinary words pay nothing.
 */
const ALL_CAPS: SizeTable = {
	buckets: [
		[6, 141],
		[10, 94],
		[14, 65],
		[18, 52],
	],
	smallest: 44,
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
