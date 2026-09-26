// src/components/agenda/meeting-flyer.tsx
//
// The marketing flyer (#931): a printable one-page poster for the next
// meeting, and a square 1080x1080 version for posting as an image in a group
// chat or on social media.
//
// Presentational only — no data access, no routing — so it renders to static
// markup for the browser-backed PNG test. The content arrives already filled in
// (`buildFlyerContent`, `#/lib/promo-template`).
//
// Two rules this surface carries:
//
//   - The QR opens the PUBLIC meeting page. That page is where a guest finds
//     everything else, the online link included; the flyer itself never prints
//     that link (#731/#754), and the #731 source guard
//     sweeps this file raw.
//   - No official wordmark (ADR-0024). The non-affiliation disclaimer is on
//     both layouts: the Letter poster through `DarkFooter`, the square through
//     the same constant.

import { QRCodeSVG } from "qrcode.react";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import type { FlyerContent } from "#/lib/promo-template";
import { ClubLogo } from "./club-logo";
import {
	DarkFooter,
	FitPage,
	FOREST,
	INK,
	Kick,
	LAGOON,
	MINT,
	MUTED,
	SANS,
	SERIF,
} from "./print-theme";

/** The square layout's edge in CSS px — and the exported PNG's, at 1x. */
export const FLYER_SQUARE_PX = 1080;

/** The Letter poster's QR edge. Large on purpose: it is read off a wall. */
export const FLYER_QR_PX = 200;

/** The square's QR edge. The quiet zone around it is its own white plate. */
export const FLYER_SQUARE_QR_PX = 300;

/** What the QR says under it. */
export const FLYER_QR_CAPTION = "Scan for details";

function whenLine(c: FlyerContent): string {
	return [c.date, c.time].filter(Boolean).join(" · ");
}

/** The QR, or an empty box of the same size while the link is not known yet
 *  (the route learns its origin after mount). */
function FlyerQr({ value, size }: { value: string; size: number }) {
	if (!value) return <div style={{ width: size, height: size }} />;
	return <QRCodeSVG value={value} size={size} marginSize={0} />;
}

export function MeetingFlyerLetter({
	content,
	clubName,
	logoUrl = null,
}: {
	content: FlyerContent;
	clubName: string;
	logoUrl?: string | null;
}) {
	const when = whenLine(content);
	return (
		<FitPage>
			<div
				data-flyer-letter=""
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					padding: "56px 64px 40px",
					gap: 28,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
					<ClubLogo logoUrl={logoUrl} height={64} maxWidth={220} />
					<Kick style={{ fontSize: 14, letterSpacing: ".18em" }}>
						{clubName}
					</Kick>
				</div>

				<h1
					style={{
						fontFamily: SERIF,
						fontSize: 52,
						lineHeight: 1.08,
						fontWeight: 700,
						margin: 0,
						color: INK,
					}}
				>
					{content.headline}
				</h1>

				{content.note ? (
					<div
						data-testid="flyer-note"
						style={{
							background: MINT,
							borderLeft: `6px solid ${LAGOON}`,
							padding: "14px 18px",
							fontSize: 22,
							fontWeight: 700,
							color: FOREST,
						}}
					>
						{content.note}
					</div>
				) : null}

				<div style={{ display: "flex", gap: 36, alignItems: "flex-start" }}>
					<div style={{ flex: 1, minWidth: 0 }}>
						{when ? (
							<div style={{ fontSize: 28, fontWeight: 800, color: INK }}>
								{when}
							</div>
						) : null}
						{content.location ? (
							<div style={{ fontSize: 22, marginTop: 8, color: INK }}>
								{content.location}
							</div>
						) : null}
						{content.online ? (
							<div style={{ fontSize: 16, marginTop: 6, color: MUTED }}>
								{content.online}
							</div>
						) : null}
						{content.theme ? (
							<div style={{ fontSize: 20, marginTop: 14, color: FOREST }}>
								Theme: <strong>{content.theme}</strong>
							</div>
						) : null}
						{content.intro ? (
							<p
								style={{
									fontSize: 17,
									lineHeight: 1.45,
									whiteSpace: "pre-line",
									margin: "16px 0 0",
								}}
							>
								{content.intro}
							</p>
						) : null}
					</div>
					<div
						style={{
							flex: "none",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: 10,
						}}
					>
						<FlyerQr value={content.meetingLink} size={FLYER_QR_PX} />
						<span style={{ fontSize: 15, fontWeight: 700, color: MUTED }}>
							{FLYER_QR_CAPTION}
						</span>
					</div>
				</div>

				{content.whyJoin.length > 0 ? (
					<div>
						<Kick style={{ fontSize: 13 }}>Why come?</Kick>
						<ul
							style={{
								margin: "10px 0 0",
								paddingLeft: 24,
								fontSize: 20,
								lineHeight: 1.5,
							}}
						>
							{content.whyJoin.map((b) => (
								<li key={b}>{b}</li>
							))}
						</ul>
					</div>
				) : null}

				{content.callToAction ? (
					<p
						style={{
							fontFamily: SERIF,
							fontSize: 24,
							fontStyle: "italic",
							margin: 0,
							color: INK,
						}}
					>
						{content.callToAction}
					</p>
				) : null}
			</div>
			<DarkFooter left={clubName} right={when} />
		</FitPage>
	);
}

/**
 * The square image layout. A fixed 1080x1080 box, never scaled: the PNG export
 * captures it at 1x, so this is the image pixel for pixel. `logoSrc` must be a
 * `data:` URL by the time it is exported (`exportSquarePng` refuses anything
 * else), so a logo that could not be inlined fails loudly instead of leaving a
 * hole in the image.
 */
export function MeetingFlyerSquare({
	content,
	clubName,
	logoSrc = null,
}: {
	content: FlyerContent;
	clubName: string;
	logoSrc?: string | null;
}) {
	const when = whenLine(content);
	return (
		<div
			data-flyer-square=""
			style={{
				width: FLYER_SQUARE_PX,
				height: FLYER_SQUARE_PX,
				boxSizing: "border-box",
				background: "#fff",
				color: INK,
				fontFamily: SANS,
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				textAlign: "center",
				padding: "56px 72px 32px",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 20,
					height: 120,
				}}
			>
				{logoSrc ? (
					<img
						data-flyer-logo=""
						src={logoSrc}
						alt=""
						style={{
							height: 120,
							width: "auto",
							maxWidth: 320,
							objectFit: "contain",
						}}
					/>
				) : null}
				<div
					style={{
						fontSize: 26,
						fontWeight: 800,
						letterSpacing: ".12em",
						textTransform: "uppercase",
						color: FOREST,
					}}
				>
					{clubName}
				</div>
			</div>
			<div
				style={{
					fontFamily: SERIF,
					fontSize: 60,
					lineHeight: 1.08,
					fontWeight: 700,
					marginTop: 28,
				}}
			>
				{content.headline}
			</div>
			{when ? (
				<div style={{ fontSize: 36, fontWeight: 800, marginTop: 22 }}>
					{when}
				</div>
			) : null}
			{content.location ? (
				<div style={{ fontSize: 28, marginTop: 8 }}>{content.location}</div>
			) : null}
			{content.theme ? (
				<div style={{ fontSize: 26, marginTop: 8, color: FOREST }}>
					Theme: {content.theme}
				</div>
			) : null}
			{content.note ? (
				<div
					style={{
						fontSize: 26,
						fontWeight: 700,
						marginTop: 14,
						color: LAGOON,
					}}
				>
					{content.note}
				</div>
			) : null}
			<div
				style={{
					marginTop: "auto",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 10,
				}}
			>
				<div style={{ background: "#fff", padding: 20 }}>
					<FlyerQr value={content.meetingLink} size={FLYER_SQUARE_QR_PX} />
				</div>
				<div style={{ fontSize: 24, fontWeight: 700, color: MUTED }}>
					{FLYER_QR_CAPTION}
				</div>
			</div>
			<div
				style={{
					fontSize: 13,
					lineHeight: 1.35,
					color: MUTED,
					marginTop: 18,
				}}
			>
				{TOASTMASTERS_DISCLAIMER}
			</div>
		</div>
	);
}
