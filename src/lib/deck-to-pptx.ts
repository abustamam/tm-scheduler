// Second renderer of the present-mode deck: turns the same Slide[] into a native,
// editable PowerPoint (.pptx). Consumes the shared slideLayout descriptor so copy
// and layout stay in lockstep with the on-screen present view. pptxgenjs is ~1 MB
// and imported type-only here (erased at build); the constructor is passed in and
// the library is dynamic-import()ed at click time (see pptx-download-button.tsx).
import type PptxGenJS from "pptxgenjs";
import type { Slide } from "./agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "./brand";
import {
	type Body,
	footerDate,
	type Line,
	type SlideLayout,
	SPLASH_LOGO_HEIGHT_PCT,
	SPLASH_LOGO_MAX_WIDTH_PCT,
	SPLASH_RULE_WIDTH_PCT,
	slideLayout,
} from "./slide-layout";

type PptxCtor = typeof PptxGenJS;
type Presentation = InstanceType<PptxCtor>;
type PptxSlide = PptxGenJS.Slide;

const INK = "2b2b2b";
const MAROON = "770D29";
const NAVY = "004062";
const GROUND = "f3f4f4";
const MUTED = "565656";
const GOLD = "f3dd94";

import {
	inchesOfWidth,
	SLIDE_BODY_BOTTOM_PCT,
	SLIDE_FOOTER_HEIGHT_PCT,
	SLIDE_HEADER_GAP_PCT,
	SLIDE_INSET_PCT,
} from "#/lib/slide-spacing";

const W = 13.33;
const H = 7.5;
/** #724: derived, not the hand-copied `1.13` that used to sit here under the
 *  comment `~8.5% of width`. The comment was right and the number was 0.003in
 *  out, which is the smaller half of the problem — the larger half is that
 *  nothing tied it to the `h-[8.5cqw]` it was copied from. */
const FOOT_H = inchesOfWidth(SLIDE_FOOTER_HEIGHT_PCT, W);

/**
 * A resolved club logo: the encoded bytes plus the image's INTRINSIC pixel
 * size. The dimensions are not decoration — `renderSplash` needs them to
 * preserve aspect ratio, because pptxgenjs cannot do it for us (see there).
 */
export type ClubLogoAsset = {
	dataUri: string;
	width: number;
	height: number;
};

/**
 * @param logo The club's resolved logo, or null. Passed in rather than read
 *   from the deck because this runs ENTIRELY IN THE BROWSER (see
 *   `pptx-download-button.tsx`) and so cannot reach the database, and because
 *   carrying ~340 KB of base64 on the deck descriptor would put it in the SSR
 *   payload of every present and meeting page — the exact cost the separate
 *   `club_logos` table exists to avoid. The caller fetches the same public URL
 *   the projected deck already displays, so a second export in a sitting is
 *   normally an HTTP-cache hit.
 *
 *   That cache is NOT what makes the export work offline, and this said it was
 *   until #514. The route answers a bounded `max-age` with `must-revalidate`
 *   since #517 — deliberately not `immutable`, which had disabled #556's
 *   takedown eviction — and `must-revalidate` forbids serving it with no
 *   network. Offline comes from the service worker's `ASSET_CACHE`, which a
 *   `fetch()` could not reach at all until #514 taught `isCacheableAsset` to
 *   match the crest by path as well as by `request.destination`. See
 *   `fetchClubLogo` in `pptx-download-button.tsx`, which does the fetching.
 */
export function deckToPptx(
	Pptx: PptxCtor,
	deck: Slide[],
	logo: ClubLogoAsset | null = null,
): Presentation {
	const pptx = new Pptx();
	pptx.layout = "LAYOUT_WIDE";
	const title = deck.find((s) => s.kind === "title");
	const fdate = title ? footerDate(title.scheduledAt, title.timezone) : "";
	const club = title?.clubName ?? "";

	for (const slide of deck) {
		// The club's logo is deck-level context, read off the title slide like
		// `club` and `fdate` above, so the CLOSING splash carries it too (#725).
		const layout = slideLayout(slide, title?.logoUrl ?? null);
		const s = pptx.addSlide();
		if (layout.chrome === "splash") renderSplash(pptx, s, layout, logo);
		else renderContent(pptx, s, layout, club, fdate);
	}
	return pptx;
}

function renderSplash(
	pptx: Presentation,
	s: PptxSlide,
	layout: Extract<SlideLayout, { chrome: "splash" }>,
	logo: ClubLogoAsset | null = null,
) {
	const dark = layout.tone === "dark";
	s.background = { color: dark ? NAVY : GROUND };

	// The club's own logo, on the two splashes that carry a `logoUrl` — the
	// opening title and the closing thank-you (#725) — and only when the caller
	// actually resolved the bytes.
	//
	// `logo` and not just `layout.logoUrl` is what decides, and it decides for
	// the WORD below as well. The bytes are fetched in the browser at click time
	// (`pptx-download-button.tsx`) and that fetch can fail, so keying the
	// fallback on the URL would hand a club whose logo 404s a splash carrying
	// neither a mark nor the word — worse than either branch on its own.
	const placed = layout.logoUrl !== null ? logo : null;
	if (placed) {
		// The same proportions the projected splash uses, in inches. The box now
		// spans the headroom the word "Toastmasters" used to occupy (it ends at
		// y=2.25) as well as the strip above it, because on a splash with a logo
		// the word is not rendered at all. Everything from the rule at y=2.5 down
		// is untouched, so a deck with a logo and one without still agree there.
		const BOX_W = inchesOfWidth(SPLASH_LOGO_MAX_WIDTH_PCT, W);
		const BOX_H = inchesOfWidth(SPLASH_LOGO_HEIGHT_PCT, W);
		const BOX_Y = 0.3;
		// Contain the image by hand. `sizing: { type: "contain" }` does NOT do
		// this: pptxgenjs derives its crop math from the w/h passed alongside it,
		// not from the image's intrinsic size, so a box and a sizing hint of the
		// same 4 x 0.85 compute a zero crop and emit `<a:stretch/>` into a
		// 4in x 0.85in frame — a square club crest came out smeared to 4.7:1 in
		// the downloaded file while rendering correctly on the projected splash.
		// Hence `ClubLogoAsset` carrying the intrinsic size.
		const scale = Math.min(BOX_W / placed.width, BOX_H / placed.height);
		const w = placed.width * scale;
		const h = placed.height * scale;
		const x = (W - w) / 2;
		const y = BOX_Y + (BOX_H - h) / 2;
		// Light plate behind it, the same treatment every other surface gives the
		// logo: an uploaded image is arbitrary, and a dark logo on this deck's
		// dark tone would otherwise be invisible. On the light tone the plate is
		// very nearly the ground colour, so it costs nothing there.
		const pad = 0.08;
		s.addShape(pptx.ShapeType.roundRect, {
			x: x - pad,
			y: y - pad,
			w: w + pad * 2,
			h: h + pad * 2,
			fill: { color: "FFFFFF" },
			line: { type: "none" },
			rectRadius: 0.06,
		});
		s.addImage({ data: placed.dataUri, x, y, w, h });
	}
	// Nominative word use, not the official wordmark image (ADR-0024). Rendered
	// only when no logo landed on this slide: the mark replaces the word rather
	// than stacking under it (#725), and a splash never shows both.
	if (!placed) {
		s.addText("Toastmasters", {
			x: 0.8,
			y: 1.35,
			w: W - 1.6,
			h: 0.9,
			align: "center",
			bold: true,
			fontSize: 40,
			color: dark ? "FFFFFF" : NAVY,
		});
	}
	// Derived, not a literal (#725). This was `w: 6` — 45% of the frame — while
	// the projected splash drew the same rule at 58%, so the logo ceiling that
	// says "the width of the rule" held on screen and overhung by 0.87in a side
	// here. Two hand-kept copies of a proportion drift; one derivation cannot,
	// which is the whole argument `slide-spacing.ts` makes for the content
	// slides.
	const RULE_W = inchesOfWidth(SPLASH_RULE_WIDTH_PCT, W);
	s.addShape(pptx.ShapeType.line, {
		x: (W - RULE_W) / 2,
		y: 2.5,
		w: RULE_W,
		h: 0,
		line: { color: dark ? "FFFFFF" : NAVY, width: 1 },
	});
	s.addText(layout.headline, {
		x: 0.8,
		y: 2.8,
		w: W - 1.6,
		h: 1.1,
		align: "center",
		bold: true,
		fontSize: 48,
		color: dark ? GOLD : INK,
		fit: "shrink",
	});
	s.addText(
		layout.sub
			.filter((l) => l.role !== "spacer")
			.map((l, i, arr) => ({
				text: l.text ?? "",
				options: {
					breakLine: i < arr.length - 1,
					bold: l.role === "strong",
					fontSize: l.role === "strong" ? 22 : 20,
					color: dark ? "DBE6EE" : MUTED,
				},
			})),
		{
			x: 0.8,
			y: 4.2,
			w: W - 1.6,
			h: 2.4,
			align: "center",
			valign: "top",
			lineSpacingMultiple: 1.15,
		},
	);
}

function renderContent(
	pptx: Presentation,
	s: PptxSlide,
	layout: Extract<SlideLayout, { chrome: "content" }>,
	club: string,
	date: string,
) {
	s.background = { color: GROUND };
	s.addText(layout.header, {
		x: INSET,
		y: 0.6,
		w: W - 2 * INSET,
		h: 0.8,
		align: "left",
		bold: true,
		fontSize: 34,
		color: INK,
	});
	s.addShape(pptx.ShapeType.rect, {
		x: INSET,
		y: 1.5,
		// 1.5 + 0.09 is `RULE_BOTTOM` above, which `BODY_Y` measures the gap from.
		w: 1.05,
		h: 0.09,
		fill: { color: MAROON },
	});
	renderBody(s, layout.body);
	s.addShape(pptx.ShapeType.rect, {
		x: 0,
		y: H - FOOT_H,
		w: W,
		h: FOOT_H,
		fill: { color: NAVY },
	});
	// GavelUp origin mark on deck chrome (ADR-0024). At `INSET`, not the `0.67`
	// it carried until #724 — the band is full-bleed, so this mark is the only
	// thing in the footer that can line up with the rule and the body above it,
	// and at 0.67 (5.03% of W) it stood 0.4in inside them.
	s.addText("GavelUp", {
		x: INSET,
		y: H - FOOT_H + 0.18,
		w: FOOT_MARK_W,
		h: FOOT_H - 0.36,
		align: "left",
		valign: "middle",
		bold: true,
		fontSize: 15,
		color: "FFFFFF",
	});
	// Right-aligned, and given the whole rest of the inset width rather than a
	// hand-placed `x: W - 5.0, w: 4.33` pair whose only job was to land its RIGHT
	// edge on the old 0.67. Stated as one inset on each side, it now reads the
	// way the HTML footer's `justify-between` inside one padding does.
	s.addText(
		[
			{ text: club, options: { breakLine: true, bold: true, fontSize: 15 } },
			{ text: date, options: { fontSize: 12, color: "D9E4EC" } },
		],
		{
			x: INSET + FOOT_MARK_W,
			y: H - FOOT_H + 0.18,
			w: W - 2 * INSET - FOOT_MARK_W,
			h: FOOT_H - 0.36,
			align: "right",
			valign: "middle",
			color: "FFFFFF",
		},
	);
	// Trademark fine print, centered along the very bottom of the navy band,
	// inside the same inset as everything else on the slide.
	s.addText(TOASTMASTERS_DISCLAIMER, {
		x: INSET,
		y: H - 0.27,
		w: W - 2 * INSET,
		h: 0.22,
		align: "center",
		valign: "middle",
		fontSize: 5,
		color: "9FB6C2",
	});
}

// #359: derived from the SHARED proportions, not hand-kept literals. The header
// inset was 0.8in (6.0% of W) and the body 1.0in (7.5%) — a mismatch this file
// and `meeting-present.tsx` each carried independently, so the export and the
// screen agreed with each other while both indented the body past its own rule.
const INSET = inchesOfWidth(SLIDE_INSET_PCT, W);
/** Width reserved for the "GavelUp" mark at the footer's left. Not a proportion
 *  worth sharing with the HTML deck, which sizes that mark by its own text: it
 *  is here only so the club/date block beside it can claim "the rest of the
 *  inset width" rather than be hand-placed against the right edge. */
const FOOT_MARK_W = 2.5;
/** Rule bottom, from the header block below. */
const RULE_BOTTOM = 1.5 + 0.09;
const BODY_Y = RULE_BOTTOM + inchesOfWidth(SLIDE_HEADER_GAP_PCT, W);
const BODY = {
	x: INSET,
	y: BODY_Y,
	w: W - 2 * INSET,
	h: H - FOOT_H - BODY_Y - inchesOfWidth(SLIDE_BODY_BOTTOM_PCT, W),
};

function renderBody(s: PptxSlide, body: Body) {
	if (body.form === "word") {
		const runs: { text: string; options: Record<string, unknown> }[] = [
			{
				text: body.word,
				options: { fontSize: 82, breakLine: true, color: INK },
			},
		];
		if (body.definition)
			runs.push({
				text: `\n${body.definition}`,
				options: { fontSize: 26, color: MUTED, breakLine: true },
			});
		if (body.example)
			runs.push({
				text: `\n“${body.example}”`,
				options: {
					fontSize: 26,
					italic: true,
					color: MUTED,
					breakLine: body.presenter != null,
				},
			});
		if (body.presenter)
			runs.push({
				text: `\n${body.presenter}`,
				options: { fontSize: 20, color: MUTED },
			});
		s.addText(runs, {
			...BODY,
			align: "center",
			valign: "middle",
			fit: "shrink",
		});
		return;
	}
	if (body.form === "bullets") {
		const runs: PptxGenJS.TextProps[] = body.items.map((t, i) => ({
			text: t,
			options: {
				breakLine: i < body.items.length - 1 || body.link != null,
				bullet: { characterCode: "2022" },
			},
		}));
		if (body.link) {
			// "Link: Presentation" — the word "Presentation" is a clickable hyperlink.
			runs.push({
				text: "Link: ",
				options: { bullet: { characterCode: "2022" } },
			});
			runs.push({
				text: "Presentation",
				options: { hyperlink: { url: body.link } },
			});
		}
		if (body.note) {
			// A muted, unbulleted line under the last bullet (#355). The run options
			// below override the block's bold 40pt, so it reads as context.
			const last = runs[runs.length - 1];
			if (last) last.options = { ...last.options, breakLine: true };
			runs.push({
				text: body.note,
				options: { bullet: false, bold: false, fontSize: 26, color: MUTED },
			});
		}
		if (body.detail.length > 0) {
			// The Table Topics notes (#880), one paragraph per line, unbulleted and
			// smaller than the bullets as on screen. A gap line carries one space so
			// it is still a paragraph of its own rather than an empty run.
			const last = runs[runs.length - 1];
			if (last) last.options = { ...last.options, breakLine: true };
			body.detail.forEach((t, i) => {
				runs.push({
					text: t || " ",
					options: {
						bullet: false,
						bold: false,
						fontSize: 24,
						color: INK,
						breakLine: i < body.detail.length - 1,
					},
				});
			});
		}
		s.addText(runs, {
			...BODY,
			align: "left",
			valign: "middle",
			bold: true,
			fontSize: 40,
			color: INK,
			fit: "shrink",
			lineSpacingMultiple: 1.3,
		});
		return;
	}
	if (body.form === "numbered") {
		s.addText(
			body.items.map((t, i) => ({
				text: t,
				options: {
					breakLine: i < body.items.length - 1,
					bullet: { type: "number" },
				},
			})),
			{
				...BODY,
				align: "left",
				valign: "middle",
				bold: true,
				fontSize: 46,
				color: INK,
				fit: "shrink",
				lineSpacingMultiple: 1.3,
			},
		);
		return;
	}
	const runs = body.lines
		.filter((l) => l.role !== "spacer")
		.map((l, i, arr) => lineRun(l, i < arr.length - 1));
	s.addText(runs, {
		...BODY,
		align: "center",
		valign: "middle",
		color: INK,
		fit: "shrink",
		lineSpacingMultiple: 1.2,
	});
}

function lineRun(l: Line, br: boolean) {
	const base = { breakLine: br };
	if (l.role === "name")
		return {
			text: `•  ${l.text}`,
			options: { ...base, bold: true, fontSize: 40 },
		};
	if (l.role === "muted")
		return {
			text: l.text ?? "",
			options: { ...base, fontSize: 26, color: MUTED },
		};
	if (l.role === "strong")
		return {
			text: l.text ?? "",
			options: { ...base, bold: true, fontSize: 28 },
		};
	return { text: l.text ?? "", options: { ...base, bold: true, fontSize: 46 } };
}

/** Sanitize a string for use inside a filename (drop path/reserved chars). */
function fileSafe(s: string): string {
	return s
		.replace(/[/\\?%*:|"<>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Meaningful download name, e.g. `Acme Toastmasters - 2026-07-15 Agenda.pptx`. */
export function pptxFileName(
	clubName: string,
	scheduledAt: Date,
	timezone: string,
): string {
	const isoDay = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone: timezone,
	}).format(scheduledAt);
	const club = fileSafe(clubName) || "Club";
	return `${club} - ${isoDay} Agenda.pptx`;
}
