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
	POSTER_FONT_WEIGHT,
	POSTER_PAD_X,
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
							fontSize: 30,
							lineHeight: 1.4,
							fontWeight: 500,
							margin: 0,
							// 23em = 690px at 30px, just inside the 704px content box, so
							// the definition is measurably narrower than full width rather
							// than filling it. 26em (780px) never bound and did nothing.
							maxWidth: "23em",
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
							fontSize: 23,
							lineHeight: 1.5,
							fontStyle: "italic",
							color: MUTED,
							margin: def ? "34px 0 0" : 0,
							// 26em = 598px at 23px, which genuinely binds inside the box.
							maxWidth: "26em",
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
