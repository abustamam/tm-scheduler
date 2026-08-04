// src/components/agenda/word-of-the-day-poster.tsx
//
// A one-page printable carrying a meeting's Word of the Day in display type,
// with its definition and example usage beneath. Printed on letter portrait and
// taped to the wall so the room can read it from any seat for the whole
// meeting.
//
// Presentational only — no data access, no routing — so it unit-tests the way
// `club-role-sheet.tsx` does. Shares the print aesthetic (brand tokens,
// one-page FitPage, Kick, DarkFooter) via `./print-theme` (#345).
//
// Deliberately does NOT credit the Grammarian, unlike the Present-mode Word of
// the Day slide: this hangs for the whole meeting, where attribution reads as
// clutter and goes stale if the role is reassigned after printing.

import {
	CONTENT_W,
	POSTER_FONT_WEIGHT,
	POSTER_PAD_X,
	posterBodySize,
	posterWordSize,
} from "#/lib/word-poster";
import { ClubLogo } from "./club-logo";
import { DarkFooter, FitPage, Kick, MUTED, SANS, SERIF } from "./print-theme";

export function WordOfTheDayPoster({
	word,
	definition,
	example,
	clubName,
	dateLong,
	logoUrl = null,
}: {
	word: string;
	definition: string | null;
	example: string | null;
	clubName: string;
	dateLong: string;
	/** Versioned logo URL, or null. */
	logoUrl?: string | null;
}) {
	// Whitespace-only is absent: an all-spaces definition must not print an empty
	// block, and the route's "is there a word" check trims the same way. The word
	// is trimmed for both sizing and rendering, so padding can never widen it.
	const w = word.trim();
	const def = definition?.trim() || null;
	const ex = example?.trim() || null;

	return (
		<FitPage>
			<div
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					padding: `64px ${POSTER_PAD_X}px`,
					textAlign: "center",
				}}
			>
				<Kick style={{ fontSize: 15, letterSpacing: ".22em" }}>
					Word of the Day
				</Kick>

				<div
					style={{
						fontFamily: SERIF,
						fontSize: posterWordSize(w),
						// Not a literal: the sizes above were derived at this weight.
						fontWeight: POSTER_FONT_WEIGHT,
						lineHeight: 1.05,
						margin: "40px 0",
						// Backstop for a word longer than the smallest bucket expects.
						// `hyphens` first, so a fired backstop breaks at a real
						// hyphenation point ("obstreperous-ness") rather than mid-syllable
						// ("OBSTREPEROUSN / ESS"), which reads as a typo on a wall.
						// <html lang="en"> (__root.tsx) is what gives the browser a
						// language to hyphenate in.
						hyphens: "auto",
						overflowWrap: "anywhere",
						maxWidth: "100%",
					}}
				>
					{w}
				</div>

				{def ? (
					<p
						data-testid="wod-definition"
						style={{
							fontFamily: SANS,
							// A third of the word's size, clamped — so the word keeps the
							// same dominance whether it is "Apt" or a 22-letter mouthful.
							fontSize: posterBodySize(w),
							lineHeight: 1.4,
							fontWeight: 500,
							margin: 0,
							// 23em is the measure (~65 characters) this is set to; the cap
							// is what keeps that intent from exceeding the content box now
							// that the size varies — 23em is 690px at 30px but 736px at the
							// 32px ceiling, wider than the 704px box.
							maxWidth: `min(23em, ${CONTENT_W}px)`,
						}}
					>
						{def}
					</p>
				) : null}

				{ex ? (
					<p
						data-testid="wod-example"
						style={{
							fontFamily: SANS,
							// Same size as the definition, as in Present mode: the example
							// is set apart by italics, the muted colour and the quotes, not
							// by being smaller.
							fontSize: posterBodySize(w),
							lineHeight: 1.5,
							fontStyle: "italic",
							color: MUTED,
							margin: def ? "34px 0 0" : 0,
							// Same measure and the same cap as the definition above.
							maxWidth: `min(23em, ${CONTENT_W}px)`,
						}}
					>
						{`“${ex}”`}
					</p>
				) : null}
			</div>

			{/* Logo in the footer beside the club name, NOT in the body: the word's
			    font size is derived from a measured table and the page must stay
			    exactly one sheet — a blank second page shipped from this component
			    once already.

			    The footer band DOES grow by a few px when a club has a logo (a 20px
			    image plus its plate against an 11px text line), which is safe here
			    only because `FitPage` measures the composed page and scales it to
			    `PAGE_H - 2` when it overflows. Verified at one page with and
			    without a logo — do not restate this as "the height is unchanged",
			    which is what this comment used to claim. */}
			<DarkFooter
				left={
					<span style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<ClubLogo logoUrl={logoUrl} height={20} maxWidth={72} />
						{clubName}
					</span>
				}
				right={dateLong}
			/>
		</FitPage>
	);
}
