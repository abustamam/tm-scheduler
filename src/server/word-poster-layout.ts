/**
 * The Word of the Day poster as a `@react-pdf/renderer` PAGE, for the meeting
 * packet (#589).
 *
 * A SECOND renderer for a surface that already has one — the HTML poster at
 * `components/agenda/word-of-the-day-poster.tsx`, printed from
 * `/club/:clubId/meeting/:key/word`. That is a real cost and the reason it is
 * paid: the packet is one PDF assembled server-side with no browser (the
 * property `role-sheets-pdf-logic.ts` exists for), and the five role sheets
 * that make up its bulk are already react-pdf. Re-implementing THEM in HTML to
 * match the poster would be the same duplication pointed the other way, over
 * five surfaces instead of one.
 *
 * WHAT IS SHARED IS THE PART THAT WAS MEASURED. `posterWordSize` /
 * `posterBodySize` (`#/lib/word-poster`) are derived by a harness
 * (`scripts/measure-word-poster.ts`) so a long word shrinks to fit instead of
 * breaking mid-word on a wall poster; that table is not something to eyeball a
 * second time. This module converts their px to points and lays the page out.
 * So the two renderers differ in LAYOUT only — if they ever disagree about how
 * big a word should be, the bug is here, not in two places.
 *
 * The conversion is close to exact rather than a fudge: the HTML poster's
 * `CONTENT_W` is 704px, which is 528pt, against this page's 524pt of content
 * width — within one percent, so a word sized to fit one fits the other.
 *
 * Original content, NO Toastmasters International copyrighted material, same
 * as the role sheets. `React.createElement` rather than JSX so this stays a
 * `.ts` module, matching `role-sheet-layout.ts` and `minutes-pdf-logic.ts`.
 * No `#/db` import, so it never reaches the browser bundle.
 */
import { Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement as h, type ReactNode } from "react";
import { pxToPt } from "#/lib/agenda-print-type";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { cap } from "#/lib/cap";
import { WOD_LIMITS } from "#/lib/wod-limits";
import { CONTENT_W, posterBodySize, posterWordSize } from "#/lib/word-poster";

/** LETTER content width in points, at this page's horizontal padding. */
const CONTENT_PT = 612 - 44 * 2;

/**
 * px → pt for the shared sizing table.
 *
 * Scaled by the ratio of the two content widths as well as by the unit, so a
 * word that exactly fills the HTML poster exactly fills this one. The ratio is
 * ~0.99, so it changes little — it is here so the relationship is stated rather
 * than left to coincide.
 */
function posterPt(px: number): number {
	return pxToPt(px) * (CONTENT_PT / (CONTENT_W * 0.75));
}

const C = { ink: "#1f2933", soft: "#52606d", line: "#b8c1cc" };

const s = StyleSheet.create({
	page: {
		paddingTop: 56,
		paddingBottom: 54,
		paddingHorizontal: 44,
		fontFamily: "Helvetica",
		color: C.ink,
		display: "flex",
		flexDirection: "column",
	},
	kicker: {
		fontSize: 11,
		fontFamily: "Helvetica-Bold",
		color: C.soft,
		letterSpacing: 2.4,
		textAlign: "center",
	},
	// The block is centred VERTICALLY as well as horizontally: this hangs on a
	// wall and is read from across the room, where a top-weighted page reads as
	// a mistake rather than as a design.
	middle: {
		flexGrow: 1,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
	},
	word: { fontFamily: "Times-Bold", textAlign: "center" },
	body: { color: C.ink, textAlign: "center", marginTop: 18 },
	example: { color: C.soft, textAlign: "center", marginTop: 10 },
	footer: {
		borderTopWidth: 1,
		borderTopColor: C.line,
		paddingTop: 8,
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "flex-end",
	},
	footerText: { fontSize: 8, color: C.soft },
	logo: { height: 26, objectFit: "contain" },
});

export interface WordPosterFill {
	word: string;
	definition: string | null;
	example: string | null;
	clubName: string;
	dateLong: string;
	/** The club's own logo as a base64 data URI, or absent. A URL would make
	 *  react-pdf fetch back into this app; the bytes are already to hand. */
	logoDataUri?: string | null;
}

/**
 * One poster page.
 *
 * `reactKey` is required because packets render several of these as siblings —
 * three by default, "3 pieces of paper that have the same thing, so we can put
 * it in various places of the meeting room".
 */
export function buildWordPosterPage(
	fill: WordPosterFill,
	reactKey: string,
): ReactNode {
	// Trimmed for sizing AND rendering, so padding can never widen the word —
	// the same rule the HTML poster states. Capped on the way out because this
	// reaches a public PDF and the columns are unbounded `text`.
	const word = cap(fill.word.trim(), WOD_LIMITS.word);
	const def = fill.definition?.trim()
		? cap(fill.definition.trim(), WOD_LIMITS.definition)
		: null;
	const ex = fill.example?.trim()
		? cap(fill.example.trim(), WOD_LIMITS.example)
		: null;

	return h(
		Page,
		{ key: reactKey, size: "LETTER", style: s.page },
		h(Text, { style: s.kicker }, "WORD OF THE DAY"),
		h(
			View,
			{ style: s.middle },
			h(
				Text,
				{ style: [s.word, { fontSize: posterPt(posterWordSize(word)) }] },
				word,
			),
			def
				? h(
						Text,
						{ style: [s.body, { fontSize: posterPt(posterBodySize(word)) }] },
						def,
					)
				: null,
			// Italic, and quoted, so a sentence USING the word cannot be misread as
			// a second definition of it.
			ex
				? h(
						Text,
						{
							style: [
								s.example,
								{
									fontSize: posterPt(posterBodySize(word)) * 0.82,
									fontFamily: "Times-Italic",
								},
							],
						},
						`“${ex}”`,
					)
				: null,
		),
		h(
			View,
			{ style: s.footer },
			h(Text, { style: s.footerText }, `${fill.clubName} · ${fill.dateLong}`),
			fill.logoDataUri
				? h(Image, { src: fill.logoDataUri, style: s.logo })
				: null,
		),
		h(
			Text,
			{ style: [s.footerText, { marginTop: 6 }] },
			TOASTMASTERS_DISCLAIMER,
		),
	);
}
