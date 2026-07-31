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
import { DarkFooter, FitPage, Kick, MUTED, SANS, SERIF } from "./print-theme";

export function WordOfTheDayPoster({
	word,
	definition,
	example,
	clubName,
	dateLong,
}: {
	word: string;
	definition: string | null;
	example: string | null;
	clubName: string;
	dateLong: string;
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

			<DarkFooter left={clubName} right={dateLong} />
		</FitPage>
	);
}
