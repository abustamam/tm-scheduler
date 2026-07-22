// src/components/agenda/print-theme.tsx
//
// Shared print/agenda primitives: the GavelUp brand tokens, the one-page
// `FitPage` scale-to-fit sheet, the `Kick` section label, and the `DarkFooter`
// (with the non-affiliation disclaimer). Extracted per #345 so the meeting
// agenda print layouts (`meeting-agenda-print.tsx`) and the club role sheet
// (`club-role-sheet.tsx`) share one copy instead of each carrying their own.
import { useEffect, useRef, useState } from "react";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

// Brand palette transcribed from templates/meeting-agenda/MeetingAgenda.dc.html.
export const INK = "#173a40";
export const LAGOON = "#328f97";
export const TEAL = "#4fb8b2";
export const MUTED = "#416166";
export const GREEN = "#2f9e5b";
export const FOREST = "#2f6a4a";
export const AMBER = "#d99a2e";
export const RED = "#c8482f";
export const OPEN = "#a8761a";
export const MINT = "#f3faf5";
export const SEAFOAM = "#8fd6d0";
export const SERIF = "'Fraunces', Georgia, serif";
export const SANS = "'Manrope', ui-sans-serif, system-ui, sans-serif";
export const HAIR = "1px solid rgba(23,58,64,.08)";

// US Letter at 96 CSS px/in. The outer sheet is fixed at exactly this so one
// .agenda-page always maps to one printed page.
export const PAGE_W = 816;
export const PAGE_H = 1056;

/** The letter-sized sheet: fixed size, clipped, prints its background fills. */
export const PAGE_OUTER: React.CSSProperties = {
	width: PAGE_W,
	height: PAGE_H,
	background: "#fff",
	boxShadow: "0 14px 44px rgba(23,58,64,.22)",
	overflow: "hidden",
	position: "relative",
	color: INK,
	fontFamily: SANS,
	// Browsers drop background colors/images when printing by default; this keeps
	// the signal dots, dark footer, header gradient, mint cards, and zebra rows.
	printColorAdjust: "exact",
	WebkitPrintColorAdjust: "exact",
};

/**
 * One letter page that never overflows onto a second sheet.
 *
 * Renders its children at the natural 816px width, measures the real content
 * height once (after webfonts settle), and if it's taller than the sheet,
 * reflows the content at a wider virtual width and scales it back down. Because
 * the pre-scale width is 816/scale, the scaled result is exactly 816px wide
 * (full-bleed preserved) and ≤ 1056px tall (nothing clipped) — true WYSIWYG:
 * the on-screen card matches the printed page.
 */
export function FitPage({ children }: { children: React.ReactNode }) {
	const innerRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<number | null>(null);

	useEffect(() => {
		const el = innerRef.current;
		if (!el || fit !== null) return; // measure once, at the natural width
		let cancelled = false;
		const measure = () => {
			if (cancelled) return;
			const h = el.scrollHeight;
			// -2px guard against the "content == page height" phantom blank page.
			if (h > PAGE_H) setFit((PAGE_H - 2) / h);
		};
		const fonts = (
			document as Document & { fonts?: { ready: Promise<unknown> } }
		).fonts;
		if (fonts?.ready) fonts.ready.then(measure);
		else measure();
		return () => {
			cancelled = true;
		};
	}, [fit]);

	return (
		<div className="agenda-page" style={PAGE_OUTER}>
			<div
				ref={innerRef}
				style={{
					width: fit ? PAGE_W / fit : PAGE_W,
					minHeight: fit ? undefined : PAGE_H,
					transform: fit ? `scale(${fit})` : undefined,
					transformOrigin: "top left",
					display: "flex",
					flexDirection: "column",
					flex: "none",
				}}
			>
				{children}
			</div>
		</div>
	);
}

/** A small uppercase section label ("Meeting Roles", "Run of Show", …). */
export function Kick({
	children,
	style,
}: {
	children: React.ReactNode;
	style?: React.CSSProperties;
}) {
	return (
		<div
			style={{
				textTransform: "uppercase",
				letterSpacing: ".09em",
				fontSize: 9,
				fontWeight: 800,
				color: FOREST,
				...style,
			}}
		>
			{children}
		</div>
	);
}

/** The dark page footer: a left/right line plus the non-affiliation disclaimer. */
export function DarkFooter({
	left,
	right,
}: {
	left: React.ReactNode;
	right: React.ReactNode;
}) {
	return (
		<div
			style={{
				marginTop: "auto",
				background: INK,
				padding: "11px 38px",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<span style={{ fontSize: 11, fontWeight: 600, color: "#fff" }}>
					{left}
				</span>
				<span
					style={{
						fontSize: 11,
						fontWeight: 700,
						color: SEAFOAM,
						letterSpacing: ".03em",
					}}
				>
					{right}
				</span>
			</div>
			<p
				style={{
					margin: "6px 0 0",
					fontSize: 7.5,
					lineHeight: 1.35,
					color: "rgba(255,255,255,0.5)",
				}}
			>
				{TOASTMASTERS_DISCLAIMER}
			</p>
		</div>
	);
}
