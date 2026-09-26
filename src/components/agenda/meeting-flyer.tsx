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

/**
 * Clamp a block to `lines` lines with an ellipsis. Every free-text field on
 * both layouts is clamped, so its height is bounded whatever an officer types
 * up to the field's cap: the Letter poster then stays inside `FitPage`'s
 * scale-to-fit range (never flowing onto a second sheet), and the square keeps
 * its QR and disclaimer on the canvas.
 */
function clamp(lines: number): React.CSSProperties {
	return {
		display: "-webkit-box",
		WebkitBoxOrient: "vertical",
		WebkitLineClamp: lines,
		overflow: "hidden",
		overflowWrap: "anywhere",
	};
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
					gap: 24,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
					<ClubLogo logoUrl={logoUrl} height={64} maxWidth={220} />
					<Kick style={{ fontSize: 14, letterSpacing: ".18em", ...clamp(2) }}>
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
						...clamp(3),
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
							...clamp(2),
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
							<div
								style={{ fontSize: 22, marginTop: 8, color: INK, ...clamp(2) }}
							>
								{content.location}
							</div>
						) : null}
						{content.online ? (
							<div style={{ fontSize: 16, marginTop: 6, color: MUTED }}>
								{content.online}
							</div>
						) : null}
						{content.theme ? (
							<div
								style={{
									fontSize: 20,
									marginTop: 14,
									color: FOREST,
									...clamp(2),
								}}
							>
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
									...clamp(4),
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
								<li key={b}>
									<div style={clamp(2)}>{b}</div>
								</li>
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
							...clamp(2),
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
 * The square's text block takes only the space the QR and the disclaimer leave
 * it, and clips the rest. `minHeight: 0` is what lets a flex item shrink below
 * its content (its default minimum IS its content); `overflow: hidden` clips
 * what no longer fits. Named so the geometry gate can revert it in one edit.
 */
const TEXT_BLOCK_GIVES_WAY: React.CSSProperties = {
	flex: "1 1 0",
	minHeight: 0,
	overflow: "hidden",
};

/**
 * The square image layout. A fixed 1080x1080 box, never scaled: the PNG export
 * captures it at 1x, so this is the image pixel for pixel. `logoSrc` must be a
 * `data:` URL by the time it is exported (`exportSquarePng` refuses anything
 * else), so a logo that could not be inlined fails loudly instead of leaving a
 * hole in the image.
 *
 * ## The QR and the disclaimer can never be clipped
 *
 * The box is fixed and `overflow: hidden`, so anything that does not fit is
 * cut off — and with every field at its cap (a 160-character headline, a
 * 300-character note, a 200-character venue and theme) the text alone is
 * taller than the canvas. So the layout is two parts:
 *
 *   - the TEXT block gives way (`TEXT_BLOCK_GIVES_WAY`): it takes the space
 *     that is left and clips the rest;
 *   - the QR group and the disclaimer are `flex: none` at the bottom, so they
 *     keep their full size whatever the text does.
 *
 * Each field is also line-clamped, so long copy usually ends in an ellipsis
 * rather than a clipped half-line — but that is cosmetic; the clamps alone do
 * NOT keep the QR on the canvas at the caps. `flyer-square-geometry.test.tsx`
 * measures both boxes in Chrome with every field at its cap.
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
				padding: "48px 72px 28px",
				overflow: "hidden",
			}}
		>
			<div
				data-flyer-text=""
				style={{
					...TEXT_BLOCK_GIVES_WAY,
					width: "100%",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						gap: 20,
						height: 110,
						flex: "none",
						maxWidth: "100%",
					}}
				>
					{logoSrc ? (
						<img
							data-flyer-logo=""
							src={logoSrc}
							alt=""
							style={{
								height: 110,
								width: "auto",
								maxWidth: 300,
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
							...clamp(3),
						}}
					>
						{clubName}
					</div>
				</div>
				<div
					style={{
						fontFamily: SERIF,
						fontSize: 56,
						lineHeight: 1.08,
						fontWeight: 700,
						marginTop: 24,
						...clamp(3),
					}}
				>
					{content.headline}
				</div>
				{when ? (
					<div style={{ fontSize: 34, fontWeight: 800, marginTop: 18 }}>
						{when}
					</div>
				) : null}
				{content.location ? (
					<div style={{ fontSize: 26, marginTop: 6, ...clamp(1) }}>
						{content.location}
					</div>
				) : null}
				{content.theme ? (
					<div
						style={{ fontSize: 24, marginTop: 6, color: FOREST, ...clamp(1) }}
					>
						Theme: {content.theme}
					</div>
				) : null}
				{content.note ? (
					<div
						style={{
							fontSize: 24,
							fontWeight: 700,
							marginTop: 10,
							color: LAGOON,
							...clamp(2),
						}}
					>
						{content.note}
					</div>
				) : null}
			</div>
			<div
				data-flyer-qr=""
				style={{
					flex: "none",
					marginTop: 12,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 8,
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
				data-flyer-disclaimer=""
				style={{
					flex: "none",
					fontSize: 13,
					lineHeight: 1.35,
					color: MUTED,
					marginTop: 14,
				}}
			>
				{TOASTMASTERS_DISCLAIMER}
			</div>
		</div>
	);
}
