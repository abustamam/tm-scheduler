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
 * Which way round a print SURFACE turns its sheet.
 *
 * Orientation used to be a property of the shared stylesheet — one hardcoded
 * `size: letter portrait` that every print route inherited whether it suited
 * the content or not. It suits five of the six: an agenda, a role sheet and a
 * packet are columns of rows, and the long axis is the one they need. The Word
 * of the Day poster is the exception (#718) and it is the exception by
 * construction: it is ONE SHORT WORD set as large as it will go, so the binding
 * constraint is the measure's WIDTH, and portrait hands it the narrow axis.
 * Landscape is 1056px of sheet against 816px — 29% more measure, which
 * `posterWordSize` spends directly on type size.
 *
 * A parameter and not a second stylesheet. `CODING_STANDARDS.md`'s "print
 * routes share one stylesheet" is the rule, and a fork is exactly the drift it
 * exists to prevent — three divergent copies is where `PRINT_PAGE_CSS` came
 * from in the first place.
 */
export type PageOrientation = "portrait" | "landscape";

/**
 * The sheet's box in CSS px for an orientation.
 *
 * Landscape is the SAME letter page turned, so it swaps `PAGE_W`/`PAGE_H`
 * rather than introducing a second pair of constants that could drift from
 * them — 1056 x 816 is one edit away from wrong if it is typed out anywhere.
 */
export function pageBox(orientation: PageOrientation = "portrait"): {
	width: number;
	height: number;
} {
	return orientation === "landscape"
		? { width: PAGE_H, height: PAGE_W }
		: { width: PAGE_W, height: PAGE_H };
}

/**
 * The stylesheet every print route serves. One copy, because three diverged.
 *
 * `orientation` is the ONLY thing a caller may vary, it defaults to portrait,
 * and the default output is byte-identical to what this constant held before
 * #718 — so the agenda, the roles sheet and the packet routes print exactly the
 * page they printed yesterday and only the poster route passes anything. See
 * `PageOrientation` above for why the poster is the one surface that differs
 * and why this is a parameter rather than a second stylesheet.
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
 * stops being safe the moment those two numbers diverge. (It is also why the
 * poster route does NOT use that rule: it centres its landscape sheet through
 * an inline style on its own wrapper, where a 1056px sheet inside an 816px
 * screen viewport is a different problem from the printed page box.)
 */
export function printPageCss(
	orientation: PageOrientation = "portrait",
): string {
	return `
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
		@page { size: letter ${orientation}; margin: 0; }
	}
`;
}

/**
 * The portrait stylesheet, which is what five of the six print surfaces serve.
 *
 * Kept as a constant rather than made every caller write `printPageCss()`: it
 * is the default and the overwhelmingly common case, three routes already
 * import this name, and `print-page-reset.guard.test.ts` discovers print routes
 * by looking for it. A route that wants the other orientation calls the
 * function; everything else keeps importing this.
 */
export const PRINT_PAGE_CSS = printPageCss();

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
 * Renders its children at the sheet's natural width, measures the real content
 * height once (after webfonts settle), and if it's taller than the sheet,
 * reflows the content at a wider virtual width and scales it back down. Because
 * the pre-scale width is width/scale, the scaled result is exactly the sheet's
 * width (full-bleed preserved) and no taller than the sheet (nothing clipped) —
 * true WYSIWYG: the on-screen card matches the printed page.
 *
 * EVERY number above comes from `pageBox(orientation)`, never from `PAGE_W` /
 * `PAGE_H` directly (#718). Those two constants ARE the portrait box, so
 * closing over them looked correct for as long as every surface was portrait —
 * and a landscape sheet measured against a 1056px ceiling it can never reach
 * would silently never scale, then clip its tail against an 816px
 * `overflow: hidden` box with the page count still reporting 1. The scale-to-
 * fit maths is wrong by 29% in that direction, which is precisely the amount no
 * gate in this repo can see.
 */
/**
 * The smallest scale `FitPage` will apply before it gives up and lets the sheet
 * FLOW across pages instead (#agenda-templates).
 *
 * Scale-to-fit is right for a normal agenda, which overruns by a little. It is
 * actively wrong for a long one: a speech contest runs ~40 rows at four
 * contestants and ~58 at seven, and squeezing that onto one sheet printed the
 * body text at **3.5pt and 2.6pt** — measured, not estimated. Nothing else in
 * the repo can see it, which is the whole reason `print-density.test.tsx`
 * exists: the page count reports 1 whether the sheet is comfortable or
 * unreadable.
 *
 * 0.72 is just under the tightest scale a real standard agenda has needed
 * (~0.75 for the longest MCF fixture), so every existing sheet keeps scaling
 * exactly as it did, and only a genuinely long agenda takes the new path.
 */
export const MIN_FIT_SCALE = 0.72;

export function FitPage({
	children,
	orientation = "portrait",
}: {
	children: React.ReactNode;
	/** The sheet this page is measured and clipped against. Portrait unless the
	 *  route also serves `printPageCss("landscape")` — the two have to agree, or
	 *  the sheet is a different shape from the page box it prints into. */
	orientation?: PageOrientation;
}) {
	const innerRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<number | null>(null);
	/** Set when the content is too long to scale legibly — see MIN_FIT_SCALE.
	 *  The sheet then drops its fixed height and paginates instead. */
	const [flow, setFlow] = useState(false);
	const { width: sheetW, height: sheetH } = pageBox(orientation);

	useEffect(() => {
		const el = innerRef.current;
		if (!el || fit !== null || flow) return; // measure once, at natural width
		let cancelled = false;
		const measure = () => {
			if (cancelled) return;
			const h = el.scrollHeight;
			// -2px guard against the "content == page height" phantom blank page.
			if (h <= sheetH) return;
			const scale = (sheetH - 2) / h;
			// Too long to shrink and stay readable: print it across several sheets
			// rather than one unreadable one.
			if (scale < MIN_FIT_SCALE) setFlow(true);
			else setFit(scale);
		};
		const fonts = (
			document as Document & { fonts?: { ready: Promise<unknown> } }
		).fonts;
		if (fonts?.ready) fonts.ready.then(measure);
		else measure();
		return () => {
			cancelled = true;
		};
	}, [fit, flow, sheetH]);

	// PAGE_OUTER is the PORTRAIT sheet — every other property on it (the fills,
	// the clip, the print-colour-adjust) is orientation-independent, so the box
	// is overridden here rather than duplicated into a second style object.
	const outer: React.CSSProperties =
		orientation === "landscape"
			? { ...PAGE_OUTER, width: sheetW, height: sheetH }
			: PAGE_OUTER;

	return (
		<div
			className="agenda-page"
			style={
				flow
					? // Flowing: drop the fixed height and the clip so the browser
						// paginates. `overflow: hidden` on a full-height box would CLIP the
						// tail of a long agenda rather than carrying it to sheet two.
						{ ...outer, height: undefined, overflow: undefined }
					: outer
			}
		>
			<div
				ref={innerRef}
				// Test hook only — nothing renders off it. It names the element whose
				// `scrollHeight` the effect above measures, so a test can measure the
				// same number in a real browser (`measuredHeight`, src/test/print-page-count.ts).
				// That number IS the printed type size on this surface: everything here
				// is scaled by the sheet height / height, so a layout that grows 20%
				// taller prints 20% smaller, silently and with the page count
				// unchanged. Nothing else in the repo can see that — jsdom does no
				// layout, and the page-count gate reports 1 either way.
				data-fit-inner=""
				style={{
					width: fit ? sheetW / fit : sheetW,
					// No sheet-height floor when flowing — the sheet is as tall as it
					// needs to be and the browser breaks it into pages.
					minHeight: fit || flow ? undefined : sheetH,
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
 * The printed scan-to-vote QR's edge, in CSS px. ONE number for every printed
 * ballot QR — `DarkFooter` below, and `GridLayout`'s and `SpaciousLayout`'s
 * hand-rolled copies (`meeting-agenda-print.tsx`). Two literals is how the
 * first two drifted (#717).
 *
 * It shipped at 32, which is ~8.5mm at the 96dpi `@page` assumes, and less than
 * that in the hand: the one-page layouts sit inside `FitPage`, so the code
 * PRINTS at 32 × the sheet's scale — measured 23.6px (6.2mm) on editorial. The
 * encoded value is an origin plus `/club/<slug>/meeting/<key>/vote`, which lands
 * at QR version 3-4, so that is a ~0.2mm module: about half what a phone camera
 * resolves across a table.
 *
 * 56, not the 72 (~19mm) #717 asked for, and the binding surface is the
 * EDITORIAL SHEET rather than the footer band. Measured on the real MCF
 * 2026-08-13 agenda through `print-page-count.ts`'s harness (macOS fonts — see
 * that file on why these are not the deployed page's numbers). `FitPage` FLOWS a
 * sheet onto a second page once it needs a scale under `MIN_FIT_SCALE`, which
 * for editorial is 1464px of content:
 *
 *                    editorial              grid            printed edge
 *                 height  slack   pt     height  slack     (ed / grid)
 *   QR 32 ....... 1428px  35.9  6.366    1406px  57.9    23.6px / 24.0px
 *   QR 48 ....... 1435px  28.9  6.335    1422px  41.9    35.3px / 35.6px
 *   QR 56 ....... 1443px  20.9  6.300    1430px  33.9    40.9px / 41.3px  ←
 *   QR 64 ....... 1451px  12.9  6.265    1438px  25.9    46.5px / 46.9px
 *   QR 72 ....... 1459px   4.9  6.231    1446px  17.9    52.0px / 52.5px
 *
 * 72 does NOT push a sheet, so #717's own escape clause ("if the footer band
 * cannot fit 72px without pushing a sheet") is not what picks 56. The MARGIN
 * does. `ballot-qr-print-fit.test.tsx`'s `MIN_FLOW_SLACK_PX` requires a layout
 * to stand at least one wrapped line (16px) clear of the cliff, because that is
 * the unit of disagreement between this harness on macOS and on CI's Ubuntu —
 * no webfont resolves here and the substitute moves where lines wrap. 72 leaves
 * 4.9px and 64 leaves 12.9px; both are inside one wrap of costing the club a
 * second sheet. 56 leaves 20.9px, which is also MORE than the 18.9px the 32px
 * code stands on in `main` today — so the bigger code does not spend editorial's
 * safety margin, it adds to it.
 *
 * That is a judgement about measurement noise, not a rule from the issue, and
 * the maintainer may reasonably prefer 64 or 72 for the ~13% and ~27% larger
 * printed code. Overriding it means raising `MIN_FLOW_SLACK_PX` deliberately in
 * the same change.
 *
 * The rewrite below is what makes even 56 affordable, rather than headroom that
 * was lying around: hung beside the whole footer stack, a code up to ~41px costs
 * the sheet NOTHING. Inside the left/right row where #510 had it, 56 measured
 * 1469px and editorial FLOWED. Going past 56 is a decision about editorial's
 * density (#563), not about the QR.
 */
export const FOOTER_QR_PX = 56;

/**
 * The dark page footer: a left/right line plus the non-affiliation disclaimer.
 *
 * `ballotUrl`, when set, adds a scan-to-vote QR (#510) at the band's right edge
 * — for clubs that print the agenda instead of projecting present mode. It is
 * optional, and since #717 it is threaded to EVERY sheet of a layout rather
 * than the last: BOTH two-sheet layouts print two sides, and a club printing
 * either double-sided was handing out a front side with no way to vote.
 * `GridLayout` and `SpaciousLayout`'s page 1 hand-roll their own officer bands
 * instead of this component (see `GridLayout`'s "NO HEADROOM LEFT" note) and
 * carry their own copies of the same QR, at the same `FOOTER_QR_PX`, rather
 * than one here.
 *
 * The QR is a flex sibling of the ENTIRE footer stack — the left/right line and
 * the disclaimer both — not a member of the left/right row. That is the whole
 * reason `FOOTER_QR_PX` can be 56 instead of 32: beside a two-line disclaimer
 * the code is free up to ~41px and cheap past it, where inside the row every
 * pixel of it was height the sheet had to find. It is still INLINE
 * (`display: inline-flex`) and still inside the same band — a block-level
 * addition below the band is the shape of change that pushes a printed page
 * (`print-page-reset.guard.test.ts`).
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
			// Test hook only — nothing renders off it, same idiom as `data-fit-inner`
			// above. It names the BAND, which is the box `ballot-qr-print-fit.test.tsx`
			// has to measure directly: a sheet-height delta cannot tell "the footer
			// grew" from "the run of show did", and the band growing when there is NO
			// ballot URL is exactly what #717's AC 7 forbids.
			data-print-footer=""
			style={{
				marginTop: "auto",
				background: INK,
				padding: "11px 38px",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
				<div style={{ flex: 1, minWidth: 0 }}>
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
				{ballotUrl ? (
					<span
						className="footer-qr"
						style={{
							flex: "none",
							display: "inline-flex",
							alignItems: "center",
							gap: 7,
						}}
					>
						{/* Three lines now, from #510's two, and the same words. The
						    band is the thing that is genuinely scarce HORIZONTALLY:
						    every pixel this caption takes comes off the disclaimer's
						    column beside it, and a disclaimer pushed from two printed
						    lines to three is 10px the sheet has to find. Broken by
						    hand rather than by a width cap so the wrap points are the
						    readable ones and not wherever the platform's fallback font
						    lands. Three short lines still fit inside `FOOTER_QR_PX`,
						    so they cost the band no height at all. */}
						<span
							style={{
								fontSize: 6.5,
								lineHeight: 1.2,
								color: "rgba(255,255,255,.85)",
								fontWeight: 700,
								textAlign: "right",
							}}
						>
							Scan to vote
							<br />
							Best Speaker
							<br />
							Evaluator · Table Topics
						</span>
						<QRCodeSVG value={ballotUrl} size={FOOTER_QR_PX} marginSize={0} />
					</span>
				) : null}
			</div>
		</div>
	);
}
