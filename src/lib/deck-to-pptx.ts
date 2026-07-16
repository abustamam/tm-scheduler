// Second renderer of the present-mode deck: turns the same Slide[] into a native,
// editable PowerPoint (.pptx). Consumes the shared slideLayout descriptor so copy
// and layout stay in lockstep with the on-screen present view. pptxgenjs is ~1 MB
// and imported type-only here (erased at build); the constructor is passed in and
// the library is dynamic-import()ed at click time (see pptx-download-button.tsx).
import type PptxGenJS from "pptxgenjs";
import colorMarkPng from "#/assets/ToastmastersWordmarkColorTight.png?inline";
import whiteMarkPng from "#/assets/ToastmastersWordmarkWhiteTight.png?inline";
import type { Slide } from "./agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "./brand";
import {
	type Body,
	footerDate,
	type Line,
	type SlideLayout,
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

const W = 13.33;
const H = 7.5;
const FOOT_H = 1.13; // ~8.5% of width

// Tight wordmark aspect (px h/w) so addImage keeps the real proportions.
const MARK_RATIO = { color: 184 / 1181, white: 257 / 1641 };

function addWordmark(
	s: PptxSlide,
	tone: "color" | "white",
	opts: { x: number; y: number; w: number },
) {
	s.addImage({
		data: tone === "color" ? colorMarkPng : whiteMarkPng,
		x: opts.x,
		y: opts.y,
		w: opts.w,
		h: opts.w * MARK_RATIO[tone],
	});
}

export function deckToPptx(Pptx: PptxCtor, deck: Slide[]): Presentation {
	const pptx = new Pptx();
	pptx.layout = "LAYOUT_WIDE";
	const title = deck.find((s) => s.kind === "title");
	const fdate = title ? footerDate(title.scheduledAt, title.timezone) : "";
	const club = title?.clubName ?? "";

	for (const slide of deck) {
		const layout = slideLayout(slide);
		const s = pptx.addSlide();
		if (layout.chrome === "splash") renderSplash(pptx, s, layout);
		else renderContent(pptx, s, layout, club, fdate);
	}
	return pptx;
}

function renderSplash(
	pptx: Presentation,
	s: PptxSlide,
	layout: Extract<SlideLayout, { chrome: "splash" }>,
) {
	const dark = layout.tone === "dark";
	s.background = { color: dark ? NAVY : GROUND };
	addWordmark(s, dark ? "white" : "color", {
		x: (W - 3.4) / 2,
		y: 1.5,
		w: 3.4,
	});
	s.addShape(pptx.ShapeType.line, {
		x: (W - 6) / 2,
		y: 2.5,
		w: 6,
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
		x: 0.8,
		y: 0.6,
		w: W - 1.6,
		h: 0.8,
		align: "left",
		bold: true,
		fontSize: 34,
		color: INK,
	});
	s.addShape(pptx.ShapeType.rect, {
		x: 0.8,
		y: 1.5,
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
	addWordmark(s, "white", { x: 0.67, y: H - FOOT_H + 0.42, w: 1.7 });
	s.addText(
		[
			{ text: club, options: { breakLine: true, bold: true, fontSize: 15 } },
			{ text: date, options: { fontSize: 12, color: "D9E4EC" } },
		],
		{
			x: W - 5.0,
			y: H - FOOT_H + 0.18,
			w: 4.33,
			h: FOOT_H - 0.36,
			align: "right",
			valign: "middle",
			color: "FFFFFF",
		},
	);
	// Trademark fine print, centered along the very bottom of the navy band.
	s.addText(TOASTMASTERS_DISCLAIMER, {
		x: 0.3,
		y: H - 0.27,
		w: W - 0.6,
		h: 0.22,
		align: "center",
		valign: "middle",
		fontSize: 5,
		color: "9FB6C2",
	});
}

const BODY = { x: 1.0, y: 2.0, w: W - 2.0, h: H - FOOT_H - 2.2 };

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
				options: { fontSize: 26, italic: true, color: MUTED },
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
