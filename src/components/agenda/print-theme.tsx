// src/components/agenda/print-theme.tsx
//
// Shared print/agenda primitives: the GavelUp brand tokens, the one-page
// `FitPage` scale-to-fit sheet, the `Kick` section label, and the `DarkFooter`
// (with the non-affiliation disclaimer). Extracted per #345 so the meeting
// agenda print layouts (`meeting-agenda-print.tsx`) and the club role sheet
// (`club-role-sheet.tsx`) share one copy instead of each carrying their own.
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

// Brand palette transcribed from templates/meeting-agenda/MeetingAgenda.dc.html.
export const INK = "#173a40";
export const LAGOON = "#328f97";
export const TEAL = "#4fb8b2";
export const MUTED = "#416166";
export const GREEN = "#2f9e5b";
export const FOREST = "#2f6a4a";
export const YELLOW = "#d99a2e";
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

/**
 * The stylesheet every print route serves. One copy, because three diverged.
 *
 * The rules are not cosmetic and the reset is the load-bearing one: `@page` sets
 * `margin: 0` and each sheet is exactly `PAGE_H` tall, so leaving the screen-only
 * 28px `.pgwrap` padding in place pushes 28 + 1056 + 28 = 1112px into a 1056px
 * page box and emits a blank second sheet. That shipped once (v1.3.0.0) and got
 * past six test files, typecheck, lint and two reviews, because nothing in this
 * repo rendered a page and counted it. `print-page-count.test.tsx` does now, and
 * deleting the reset below fails it.
 *
 * This is the UNION of what the three routes carried, and each addition is inert
 * where it is not needed:
 *
 *   · `gap: 0 !important` exists for the agenda alone. `TwoPage` sets an inline
 *     `gap: 26` to space its two sheets on screen; unreset, that gap becomes a
 *     26px band between printed pages. The other surfaces have no `.pgwrap` gap
 *     for it to touch.
 *   · `break-after: page` paired with `.agenda-page:last-child { break-after:
 *     auto }` is the multi-sheet pagination the poster used to omit. The pair is
 *     harmless on a one-sheet page precisely because the only sheet is also the
 *     last child. Keep them together — half of this pair is how you get a
 *     trailing blank page.
 *   · `.footer-qr { break-inside: avoid }` (#510) keeps the scan-to-vote QR and
 *     its caption from splitting apart. `.agenda-page` is already a fixed
 *     `overflow: hidden` box, so nothing here can add a page — this only
 *     protects against a paged-media backend fragmenting the QR internally,
 *     the same defensive reasoning as the `break-after` pair above.
 *
 * What is deliberately NOT here: centring the sheet. Both single-sheet surfaces
 * centre — the roles route through a `.pgwrap` rule, the poster route through an
 * inline style on the same wrapper — but the agenda cannot, because `TwoPage`
 * stacks two sheets inside one `.pgwrap` and flex defaults to a row, which would
 * print them side by side. Two surfaces expressing one intent through two
 * mechanisms is exactly the drift this constant exists to end, so it is worth
 * knowing they are both still out here.
 *
 * The roles rule also used to apply when PRINTING (it sat outside any media
 * query); it is now scoped to `@media screen`. That is safe only because the
 * sheet is 816px and the letter page box is 816px, so block layout and centred
 * flex land on the same pixel — verified by rasterising both and diffing. It
 * stops being safe the moment those two numbers diverge.
 */
export const PRINT_PAGE_CSS = `
	@media screen { body { background: #d8e6dd; } }
	.pgwrap { padding: 28px 0; }
	@media print {
		.no-print { display: none !important; }
		body { background: #fff; }
		.pgwrap { padding: 0 !important; gap: 0 !important; }
		/* Every sheet is an .agenda-page — covers the single-page editorial and
		   grid layouts too, which aren't wrapped in .pgwrap at all. */
		.agenda-page { box-shadow: none !important; break-after: page; break-inside: avoid; }
		.agenda-page:last-child { break-after: auto; }
		.footer-qr { break-inside: avoid; }
		@page { size: letter portrait; margin: 0; }
	}
`;

/**
 * The floating screen-only toolbar each print route pins top-right.
 *
 * `flexWrap` and `justifyContent` are load-bearing for the agenda and inert
 * elsewhere, which is why they are safe to share. The agenda's toolbar carries
 * four layout tabs plus Share and Print; anchored right with no width, an
 * unwrapped row grows leftward off the viewport on a phone, and a
 * `position: fixed` toolbar cannot be scrolled back to. On the two-control
 * toolbars there is nothing to wrap and no free space to justify, so both are
 * no-ops there.
 */
// Module-private: `PrintToolbar` is the surface, so a route cannot go back to
// hand-assembling a toolbar from the raw style object.
const PRINT_TOOLBAR_STYLE: React.CSSProperties = {
	position: "fixed",
	top: 12,
	right: 12,
	zIndex: 10,
	display: "flex",
	flexWrap: "wrap",
	justifyContent: "flex-end",
	gap: 8,
	alignItems: "center",
	background: "#fff",
	borderRadius: 10,
	padding: 6,
	boxShadow: "0 6px 20px rgba(23,58,64,.18)",
};

/** The screen-only toolbar wrapper. `no-print` is what `PRINT_PAGE_CSS` hides. */
export function PrintToolbar({ children }: { children: React.ReactNode }) {
	return (
		<div className="no-print" style={PRINT_TOOLBAR_STYLE}>
			{children}
		</div>
	);
}

/** Brand button style, tokenised — two routes hardcoded LAGOON's hex. */
const PRINT_BUTTON_STYLE: React.CSSProperties = {
	padding: "6px 14px",
	background: LAGOON,
	color: "#fff",
	border: 0,
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	cursor: "pointer",
};

/** The Print button. Identical at all three call sites before this existed. */
export function PrintButton() {
	return (
		<button
			type="button"
			onClick={() => window.print()}
			style={PRINT_BUTTON_STYLE}
		>
			Print
		</button>
	);
}

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
				// Test hook only — nothing renders off it. It names the element whose
				// `scrollHeight` the effect above measures, so a test can measure the
				// same number in a real browser (`measuredHeight`, src/test/print-page-count.ts).
				// That number IS the printed type size on this surface: everything here
				// is scaled by PAGE_H/height, so a layout that grows 20% taller prints
				// 20% smaller, silently and with the page count unchanged. Nothing else
				// in the repo can see that — jsdom does no layout, and the page-count
				// gate reports 1 either way.
				data-fit-inner=""
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

/**
 * The dark page footer: a left/right line plus the non-affiliation disclaimer.
 *
 * `ballotUrl`, when set, adds a small scan-to-vote QR (#510) beside `right` —
 * for clubs that print the agenda instead of projecting present mode. It is
 * optional and threaded only to the LAST sheet of a layout (the one still on
 * the table when voting happens). `GridLayout` hand-rolls its own tight
 * officer footer instead of this component (see its "NO HEADROOM LEFT" note)
 * and carries its own, smaller copy of the same QR rather than one here.
 *
 * The QR renders INLINE (`display: inline-flex`), sharing the same row as
 * `right`, not as its own block below — a block-level addition here is the
 * shape of change that pushes a printed page (`print-page-reset.guard.test.ts`).
 */
export function DarkFooter({
	left,
	right,
	ballotUrl,
}: {
	left: React.ReactNode;
	right: React.ReactNode;
	ballotUrl?: string;
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
					gap: 12,
				}}
			>
				<span style={{ fontSize: 11, fontWeight: 600, color: "#fff" }}>
					{left}
				</span>
				<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
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
					{ballotUrl ? (
						<span
							className="footer-qr"
							style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
						>
							<QRCodeSVG value={ballotUrl} size={32} marginSize={0} />
							<span
								style={{
									fontSize: 6.5,
									lineHeight: 1.2,
									color: "rgba(255,255,255,.85)",
									fontWeight: 700,
								}}
							>
								Scan to vote
								<br />
								Best Speaker · Evaluator · Table Topics
							</span>
						</span>
					) : null}
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
