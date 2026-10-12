// src/components/agenda/meeting-sign.tsx
//
// A printable MEETING sign (#1167): one letter-LANDSCAPE sheet a club tapes up
// on the way to the room. The Toastmasters logo, the club name, MEETING, and
// either an arrow with "THIS WAY" or "Guests Welcome".
//
// THE ONE SURFACE THAT PRINTS THE OFFICIAL TOASTMASTERS LOGO. Everything else
// (agenda, deck, .pptx, poster, role sheets) renders only the club's own
// upload. ADR-0024 decision 3 is narrowed, for this file alone, on the Brand
// Manual v2.0 p.32 club-stationery basis; `ti-wordmark.guard.test.ts` pins that
// no other file may reference the SVG and that this one does.
//
// Presentational only. The sheet is built directly rather than through
// `FitPage`: the text is fixed and every size below is chosen so the worst case
// (a two-line name) fits the 816px height with room to spare, so there is
// nothing to measure or scale, and a name too long for two lines is clamped
// rather than allowed to push the sheet onto a second page.

import logoUrl from "#/assets/ToastmastersLogo3Color.svg";
import {
	INK,
	PAGE_OUTER,
	pageBox,
	SHEET_H_VAR,
	SHEET_W_VAR,
} from "./print-theme";

export type SignArrow = "left" | "right" | null;

/** Names longer than this drop a size so a typical long name stays on one line. */
export const LONG_NAME_CHARS = 28;
const NAME_PX = 54;
const LONG_NAME_PX = 40;

/** Filled arrows in a 600x80 box; the head is the last 100 units. */
const ARROW_PATH = {
	right: "M0 28 H500 V0 L600 40 L500 80 V52 H0 Z",
	left: "M600 28 H100 V0 L0 40 L100 80 V52 H600 Z",
} as const;

type SheetStyle = React.CSSProperties & Record<`--${string}`, string>;

export function MeetingSign({
	clubName,
	arrow,
}: {
	clubName: string;
	arrow: SignArrow;
}) {
	const { width, height } = pageBox("landscape");
	const name = clubName.trim().toUpperCase();
	const sheet: SheetStyle = {
		...PAGE_OUTER,
		width,
		height,
		[SHEET_W_VAR]: `${width}px`,
		[SHEET_H_VAR]: `${height}px`,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		// Centres the stack in the space above the bottom rule.
		padding: "0 64px 90px",
	};

	return (
		<div className="agenda-page" data-testid="meeting-sign" style={sheet}>
			{/* Decorative: the club name below is the text. */}
			<img src={logoUrl} alt="" style={{ height: "2.1in", width: "auto" }} />

			<div
				data-testid="sign-club-name"
				style={{
					marginTop: 20,
					maxWidth: "100%",
					fontSize: name.length > LONG_NAME_CHARS ? LONG_NAME_PX : NAME_PX,
					fontWeight: 700,
					lineHeight: 1.1,
					// A single unbroken word still breaks, and nothing beyond two
					// lines can push the sheet onto a second page.
					overflowWrap: "anywhere",
					display: "-webkit-box",
					WebkitBoxOrient: "vertical",
					WebkitLineClamp: 2,
					overflow: "hidden",
				}}
			>
				{name}
			</div>

			<div
				style={{
					marginTop: 12,
					fontSize: 112,
					fontWeight: 800,
					lineHeight: 1,
					letterSpacing: ".02em",
				}}
			>
				MEETING
			</div>

			{arrow ? (
				<>
					<div
						style={{
							marginTop: 18,
							fontSize: 44,
							fontWeight: 700,
							lineHeight: 1.1,
						}}
					>
						THIS WAY
					</div>
					<svg
						role="img"
						aria-label={`Arrow pointing ${arrow}`}
						data-testid="sign-arrow"
						data-direction={arrow}
						viewBox="0 0 600 80"
						style={{ marginTop: 14, width: "6in", height: "auto" }}
					>
						<path d={ARROW_PATH[arrow]} fill={INK} />
					</svg>
				</>
			) : (
				<>
					<div
						style={{
							marginTop: 18,
							fontSize: 60,
							fontWeight: 700,
							lineHeight: 1.1,
						}}
					>
						Guests Welcome
					</div>
					<div style={{ marginTop: 8, fontSize: 30, lineHeight: 1.3 }}>
						Please come in and find your voice.
					</div>
				</>
			)}

			<div
				style={{
					position: "absolute",
					left: 0,
					right: 0,
					bottom: "0.4in",
					height: 6,
					background: INK,
				}}
			/>
		</div>
	);
}
