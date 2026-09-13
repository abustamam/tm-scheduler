// src/lib/word-poster.ts
//
// Sizing and presence helpers for the Word of the Day poster
// (`components/agenda/word-of-the-day-poster.tsx`). "Apt" and
// "obstreperousness" cannot share a font size, and the poster's whole job is to
// be readable from the back of the room, so the word is sized from its length.
//
// Deterministic buckets rather than a measure-and-scale pass: this runs during
// SSR, needs no DOM, and is unit-testable. The poster also sets `overflowWrap`
// as a backstop for anything longer than the last bucket anticipates.
//
// ---------------------------------------------------------------------------
// THE SHEET IS LANDSCAPE (#718)
//
// The poster prints letter LANDSCAPE, alone among this repo's print surfaces,
// and the whole of that decision lands here. The poster is one short word set
// as large as it will go, so the constraint on its size is the measure's WIDTH;
// portrait handed it the sheet's narrow axis and wasted the other. The long
// edge is 1056px against 816px, so CONTENT_W went 704 → 944 and TARGET_W
// 685 → 925 — 35% more measure, spent directly on type size. "Ephemeral" prints
// at 157px where it used to print at 116px.
//
// The orientation itself lives in `print-theme.tsx` — `printPageCss(
// "landscape")` for the `@page` rule, `<FitPage orientation="landscape">` for
// the sheet. THE THREE HAVE TO AGREE. A route that serves the landscape
// stylesheet under a portrait `FitPage` prints an 816px sheet into a 1056px
// page box; one that sizes words against this table under a portrait sheet
// breaks them mid-word. Two guard tests hold the pair (`print-page-reset.guard
// .test.ts` for the stylesheet, `word-of-the-day-poster.test.tsx` for the
// geometry identity below).
//
// ---------------------------------------------------------------------------
// THE BUDGET
//
// Two numbers, and the difference between them is deliberate:
//
//   CONTENT_W (944px) = the TRUE content width, the LANDSCAPE sheet's width
//                       (PAGE_H) minus the poster's horizontal padding. Exceed
//                       it and the word breaks mid-word. A test pins it to the
//                       real values.
//   TARGET_W  (925px) = what every size below was derived against, ~2.0%
//                       narrower.
//
// THE ~19px GAP IS NOT WASTE — DO NOT RECLAIM IT. It is slack for rendering
// variance we cannot measure here. These sizes were derived in one headless
// Chrome on one machine; members print from Chrome, Firefox and Safari across
// platforms, where hinting, subpixel positioning and font-version differences
// each move text width by fractions of a percent. Sizing to exactly CONTENT_W
// would mean betting on zero difference, and an earlier revision of this table
// did exactly that — "POWWOW" landed at 704.0px on the old portrait box, 100.0%
// of budget. Any browser rendering a hair wider reintroduces the mid-word break
// these tables exist to prevent. Bumping a size up "because it still fits"
// spends that insurance.
//
// The margin stayed 19px across the turn rather than scaling with the measure,
// so its RELATIVE size fell from 2.7% to 2.0%. That is the number to revisit if
// a club ever reports a break, and it is affordable because the slack that
// actually matters is measured, not relative: the binding word of each bucket
// renders 20–28px inside the content box on both sheets, against cross-browser
// variance of fractions of a percent.
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
// TWO THINGS THAT HARNESS WILL NOT TELL YOU, both of which bit during #718:
//
//   · ITS SEARCH HAS A CEILING, and a bucket that reaches it comes back looking
//     like a measured fit. `largestFitting` walks DOWN from `MAX_CANDIDATE_PX`,
//     which was an inline 220 — never reached while the widest bucket was 173,
//     hit immediately by the ≤6 bucket at the landscape measure. It reported
//     220 with "Wampum" at 870px against a 925px target: 6% of the new measure
//     silently unspent, in the bucket this change is most visible in. The true
//     fit is 233. The ceiling is now a named 400 and `derive` FLAGS a capped
//     bucket, so it cannot happen quietly again.
//   · HEIGHT IS NOW A REAL CONSTRAINT. The landscape sheet is only 816px tall
//     against the portrait 1056, so the vertical budget fell 23% at the same
//     moment the type grew. The word, its definition and its example still have
//     to compose without `FitPage`'s scale-to-fit firing — a scaled sheet
//     prints SMALLER than this table says, silently, with the page count
//     unchanged. `print-page-count.test.tsx` measures that directly; nothing in
//     the width harness can see it.
//
// AND ONE THING NEITHER HARNESS CAN SEE: these sizes are consumed by a SECOND
// renderer. `src/server/word-poster-layout.ts` lays the same poster out as a
// react-pdf page for the meeting packet, on a LETTER PORTRAIT sheet with 524pt
// of measure. It converts px → pt through `CONTENT_W`, so re-pricing this
// module re-prices that page too. Both halves of that conversion are now pinned
// by `word-poster-layout.test.ts`; read its header before changing CONTENT_W,
// because the two sizes travel differently and #718 shipped one of them wrong.
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
// size and take the largest whose worst word is ≤ the 925px target.
//
// #718 IS THE CASE THAT MAKES THIS CONCRETE, and the temptation was real: the
// measure grew a clean 34.5% (685 → 925), so multiplying every size by 1.35
// looks like arithmetic rather than extrapolation. It is not. Measured against
// scaled: 116 → 157 either way, but 74 scales to 100 and MEASURES 111, and 61
// scales to 82 and measures 93. The long buckets lose most, because they sit
// where `opsz` is still changing fast.
//
// Note which way that error runs, because it is the reason it would have gone
// unnoticed. Widening the measure scales the sizes UP, and `opsz` makes the
// bigger letterforms relatively NARROWER, so extrapolation here under-shoots:
// it leaves 10% of the word on the table rather than breaking it. Nothing would
// have failed. (Scaling DOWN is the optimistic direction, and that is the one
// that produced the three missed retunes above.)
//
// ---------------------------------------------------------------------------
// VERIFIED COVERAGE
//
// Both tables were checked against every lowercase common word in
// `/usr/share/dict/words` — roughly 64k of them, proper nouns, acronyms and
// possessives excluded, since a Word of the Day is an ordinary word — in each
// realistic input style.
//
// The word that BINDS each bucket — i.e. the widest in the dictionary at that
// length, and so the one that set the size. Re-deriving by hand can start from
// these instead of repeating the sweep; the script reports current widths.
//
//   bucket   NORMAL (lowercase / Capitalised)   ALL_CAPS
//   ≤6       mammon / Wampum                    POWWOW
//   ≤10      mammograms                         MAMMOGRAMS / GROUNDWORK
//   ≤14      newspaperwoman                     NEWSPAPERWOMAN
//   ≤18      telecommunications                 CHLOROFLUOROCARBON
//   >18      electroencephalographs             ELECTROENCEPHALOGRAPHS
//
// The #718 re-derivation was run against exactly THIS pool rather than a fresh
// dictionary sweep, and that is worth being explicit about because it is the
// half a reader cannot check from the numbers. The sweep above used Debian's
// `wamerican`; macOS ships `web2`, which is three times the size and carries
// "antidisestablishmentarianism", "phosphammonium" and "chondromyxosarcoma" —
// none of them a Word of the Day, all of them binding. Re-deriving against web2
// would have priced every bucket for a word no club will set and SHRUNK the
// poster, which is the opposite of what #718 asked for. The recorded worst
// cases are the repo's own, and re-running the derivation over them at the OLD
// target reproduces the old table exactly (173/116/90/74/61, 141/94/65/52/44,
// same binding words) — which is what makes them trustworthy at the new one.
//
// Each size is the largest that clears the target, so ALL of these invalidate
// both tables and require re-deriving: the sheet's ORIENTATION, PAGE_W / PAGE_H,
// POSTER_PAD_X, the font family (`SERIF` in `print-theme.tsx`),
// POSTER_FONT_WEIGHT, and the bucket length boundaries. The harness reads every
// one of those from source rather than copying them, so it measures what
// actually ships — orientation reaches it through CONTENT_W.
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
 * The true usable width, `PAGE_H - 2 * POSTER_PAD_X`.
 *
 * `PAGE_H`, not `PAGE_W`, and that is the whole of #718: the poster prints
 * LETTER LANDSCAPE, so the sheet's long edge is its measure. Not derived from
 * the constant here because that lives in a React module and this one is
 * deliberately React-free; a unit test asserts the arithmetic against the real
 * page box instead.
 *
 * It was 704 (the portrait `PAGE_W - 112`) until the poster turned. Every size
 * in the two tables below was re-derived against this number by the harness —
 * they are not the old numbers scaled, because scaling them is exactly the
 * mistake "NEVER EXTRAPOLATE A SIZE" above forbids.
 */
export const CONTENT_W = 944;

/**
 * The slack between the true content width and what the sizes are derived
 * against — see THE BUDGET above for why it exists and must not be reclaimed.
 */
export const SAFETY_MARGIN = 19;

/**
 * The width sizes are derived against — CONTENT_W less the safety margin.
 * DERIVED, not a literal: as a bare number the "less the safety margin"
 * relationship was a claim in a comment that nothing enforced, so a change to
 * PAGE_W or POSTER_PAD_X would have re-priced the margin silently.
 */
export const TARGET_W = CONTENT_W - SAFETY_MARGIN;

/**
 * The display weight both tables were derived at. Exported for the same reason
 * as POSTER_PAD_X: the poster consumes it instead of a literal, and the
 * measurement harness measures at it, so a weight change cannot leave the
 * poster rendering at one weight and the sizes derived at another. Weight
 * moves advance widths, so changing it invalidates every size here.
 */
export const POSTER_FONT_WEIGHT = 600;

/**
 * A length→size table: buckets largest-first, plus the floor for anything
 * longer than the last bucket.
 */
type SizeTable = {
	buckets: readonly (readonly [maxLength: number, size: number])[];
	smallest: number;
};

/**
 * Ordinary words — lowercase or Capitalised.
 *
 * Every entry measured at the 925px landscape target (#718); the portrait table
 * these replace was 173/116/90/74/61 at 685px. Binding widths at these sizes:
 * 921.8 / 923.2 / 924.2 / 923.6 / 916.9 px — all just under target, which is
 * what "the largest size that clears it" looks like.
 *
 * The ≤6 entry was briefly 220, which was the measurement harness's own search
 * CEILING rather than a fit — it left 6% of the new measure unspent in the one
 * bucket #718 is most visible in, and it moved the packet PDF (below). The
 * ceiling is now named and generous, and `derive` flags a bucket that reaches
 * it. Do not re-introduce a number here that the harness did not measure.
 */
const NORMAL: SizeTable = {
	buckets: [
		[6, 233],
		[10, 157],
		[14, 124],
		[18, 111],
	],
	smallest: 93,
};

/**
 * ALL-CAPS words, which need their own table: capitals run ~20–30% wider than
 * lowercase, so a single table cannot serve both. "POWWOW" is 122% of the
 * content width at the normal ≤6 size and "GROUNDWORK" is 132% at the normal
 * ≤10 size — both would break mid-word. Sizing the normal table down far
 * enough to absorb that would shrink every ordinary word to pay for a styling
 * choice, so the all-caps case gets its own (much smaller) sizes instead and
 * ordinary words pay nothing.
 *
 * Re-measured at 925px for #718; was 141/94/65/52/44 at 685px. Unaffected by
 * the search-ceiling problem that briefly mis-set the normal ≤6 bucket:
 * capitals are wide enough that 190 was always a real answer.
 */
const ALL_CAPS: SizeTable = {
	buckets: [
		[6, 190],
		[10, 129],
		[14, 95],
		[18, 72],
	],
	smallest: 60,
};

/**
 * The lengths at which the size steps down, ascending — DERIVED from the
 * table, not a second copy of it. The measurement harness sweeps these ranges,
 * so moving a boundary moves what gets measured; a hardcoded copy would let
 * the harness sweep the old ranges at the new sizes and still report PASS.
 * (A unit test pins ALL_CAPS to the same boundaries.)
 */
export const BUCKET_BOUNDARIES: readonly number[] = NORMAL.buckets.map(
	([maxLength]) => maxLength,
);

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

/**
 * Body-copy size in px for the poster's definition and example, derived from
 * the word's size so the two keep a CONSTANT relationship instead of the word
 * drifting away from a fixed body size.
 *
 * A pinned body size does not survive a display size that ranges 44–173px: at
 * 30px flat, "Apt" set the word 5.8x the body while "ELECTROENCEPHALOGRAPHS"
 * set it 1.5x, so the longest words stopped dominating the sheet and the poster
 * read as a paragraph with a heading. A third of the word size holds the
 * hierarchy at every length.
 *
 * The clamp is what keeps that ratio honest at both extremes:
 *   • 20px floor — the wall-legibility limit. This is read from the back of a
 *     room, so the definition cannot follow a small word down indefinitely.
 *   • 32px ceiling — stops the definition ballooning under a SHORT word, where
 *     a third of 233px would be 78px and the body would compete with the word
 *     it is explaining.
 *
 * THE CEILING NOW BINDS ALMOST EVERYWHERE, and that is a change #718 made
 * rather than a property of the design. At the portrait sizes it caught two
 * buckets of ten and the third-of-the-word rule ran the rest (32/32/30/25/20,
 * 32/31/22/20/20). At the landscape sizes it catches seven (32/32/32/32/31,
 * 32/32/32/24/20), so an ordinary word's definition is now 32px whatever its
 * length. The hierarchy the ratio exists to protect survives — 233:32 is 7.3x
 * and 93:31 is 3.0x, both emphatic — and 32px is the most legible the
 * definition has ever been from the back of a room, which is the poster's job.
 * But "a third of the word size" now describes the tail of the range only.
 * Raising the ceiling is a typography decision and #718 was explicitly not one;
 * it also spends height, which is the axis a landscape sheet has less of. It
 * needs `print-page-count.test.tsx`'s scale-to-fit assertion re-run beside it.
 *
 * The ceiling used to double as the pricing for the poster's `min(23em,
 * CONTENT_W)` measure cap — 23em at 32px is 736px, which exceeded the old 704px
 * box. Against 944px it does not, so the cap is now slack rather than binding.
 * It stays: it is what keeps the intent from overflowing if either number moves
 * back.
 */
export function posterBodySize(word: string): number {
	return Math.min(32, Math.max(20, Math.round(posterWordSize(word) / 3)));
}

/**
 * Does this meeting have a Word of the Day to print? Whitespace-only counts as
 * unset. Three callers share it — the poster route, the "Word poster" button
 * that links there, and the meeting page — so none of them can disagree about
 * whether there is anything to show.
 *
 * A type predicate, not a plain boolean: the route hands the word straight to
 * the poster's `word: string` prop, and narrowing here is what lets it do that
 * honestly instead of casting away a `string | null` at the call site.
 *
 * The print layouts (`meeting-agenda-print.tsx`, `minutes-pdf-logic.ts`,
 * `role-sheets-pdf-logic.ts`, `recurrence-rule-logic.ts`, `agenda-slides.ts`)
 * deliberately keep bare truthiness instead of calling this. That is a
 * decision, not an oversight: every write path trims before storing, so a
 * blank-but-present word cannot exist in the database, and converting five
 * cross-surface layouts to guard against input that cannot occur would be risk
 * without benefit.
 */
export function hasWordOfTheDay(
	word: string | null | undefined,
): word is string {
	return Boolean(word?.trim());
}
