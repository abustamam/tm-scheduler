// Second renderer of the present-mode deck: turns the same `Slide[]` produced by
// `buildSlideDeck` into a native, editable PowerPoint (.pptx) file. The HTML
// present view (`meeting-present.tsx`) is the first renderer; this one emits
// real text boxes (not images) so the deck stays editable in PowerPoint/Google
// Slides. Keep the per-slide text mapping (`slideContent`) pure so it is
// unit-testable in node independent of the browser download.
//
// NOTE: `pptxgenjs` is ~1 MB. This module imports it as a *type only* (erased at
// build), and `deckToPptx` receives the constructor as an argument. Callers
// dynamic-`import()` the library at click time so it is code-split out of the
// main client bundle. Do not add a value import of "pptxgenjs" here.
import type PptxGenJS from "pptxgenjs";
import type { Slide } from "./agenda-slides";

type PptxCtor = typeof PptxGenJS;
type Presentation = InstanceType<PptxCtor>;

/** Palette mirrors the HTML present view (`meeting-present.tsx`). */
const INK = "2b2b2b";
const MAROON = "9b1c2e";
const MUTED = "565656";
const GROUND = "f3f4f4";

/**
 * The editable text of one slide, independent of pptxgenjs. `eyebrow` is the
 * small kicker (maroon), `title` the headline, `body` the supporting lines.
 * Pure so tests can assert text content per `Slide` kind.
 */
export type SlideContent = {
	eyebrow?: string;
	title: string;
	body: string[];
};

function formatTitleDate(scheduledAt: Date, timezone: string): string {
	const date = new Intl.DateTimeFormat(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	}).format(scheduledAt);
	const time = new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		timeZone: timezone,
	}).format(scheduledAt);
	return `${date} · ${time}`;
}

/** Pure mapping: one `Slide` → the editable text of one native slide. */
export function slideContent(slide: Slide): SlideContent {
	switch (slide.kind) {
		case "title": {
			const eyebrow = [
				slide.district,
				slide.clubNumber ? `Club #${slide.clubNumber}` : null,
			]
				.filter(Boolean)
				.join(" · ");
			return {
				eyebrow: eyebrow || undefined,
				title: slide.clubName,
				body: [formatTitleDate(slide.scheduledAt, slide.timezone)],
			};
		}
		case "toastmaster":
			return {
				eyebrow: "Toastmaster of the Day",
				title: slide.name,
				body: [],
			};
		case "theme":
			return {
				eyebrow: "Meeting Theme",
				title: `“${slide.theme}”`,
				body: [],
			};
		case "wordOfDay":
			return {
				eyebrow: "Word of the Day",
				title: slide.word,
				body: [
					...(slide.definition ? [slide.definition] : []),
					...(slide.example ? [`“${slide.example}”`] : []),
				],
			};
		case "geIntro":
			return {
				eyebrow: "General Evaluator",
				title: slide.name,
				body: slide.team.map((t) => `${t.role} · ${t.name}`),
			};
		case "speech":
			return {
				eyebrow: slide.label,
				title: slide.speaker,
				body: [
					...(slide.title ? [`“${slide.title}”`] : []),
					[slide.projectLevel, slide.time].filter(Boolean).join(" · "),
				].filter(Boolean),
			};
		case "voteSpeaker":
			return voteContent("Vote for Best Speaker", slide.names);
		case "tableTopics":
			return {
				eyebrow: "Table Topics",
				title: slide.master,
				body: [`Impromptu speaking · ${slide.timing}`],
			};
		case "voteTableTopics":
			return voteContent("Vote for Best Table Topics", []);
		case "evalIntro":
			return {
				eyebrow: "Evaluation Session",
				title: slide.name,
				body: [slide.time],
			};
		case "evaluation":
			return {
				eyebrow: slide.label,
				title: slide.evaluator,
				body: [
					`${slide.speaker ? `Evaluates ${slide.speaker} · ` : ""}${slide.time}`,
				],
			};
		case "voteEvaluator":
			return voteContent("Vote for Best Evaluator", slide.names);
		case "generalEvaluation":
			return {
				eyebrow: "General Evaluation",
				title: slide.name,
				body: [`Closing remarks · ${slide.time}`],
			};
		case "awards":
			return {
				eyebrow: "Awards",
				title: "Awards",
				body: slide.categories,
			};
		case "reminders":
			return {
				eyebrow: "Reminders",
				title: "Reminders",
				body: slide.text.split("\n"),
			};
		case "thankYou":
			return {
				eyebrow: undefined,
				title: "Thank you",
				body: slide.meetingSchedule ? [`We meet ${slide.meetingSchedule}`] : [],
			};
	}
	return ((_exhaustive: never) => ({ title: "", body: [] }))(slide);
}

function voteContent(label: string, names: string[]): SlideContent {
	return {
		eyebrow: label,
		title: "Cast your vote",
		body: names,
	};
}

/**
 * Build a fully-populated pptxgenjs presentation from the deck: one native
 * slide per deck slide, in order. `Pptx` is the `pptxgenjs` default export,
 * passed in so this module needs no value import of the heavy library.
 */
export function deckToPptx(Pptx: PptxCtor, deck: Slide[]): Presentation {
	const pptx = new Pptx();
	pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 in (16:9)
	const W = 13.33;

	for (const slide of deck) {
		const content = slideContent(slide);
		const s = pptx.addSlide();
		s.background = { color: GROUND };
		const isTitle = slide.kind === "title";

		let y = isTitle ? 2.6 : 1.6;

		if (content.eyebrow) {
			s.addText(content.eyebrow.toUpperCase(), {
				x: 0.8,
				y,
				w: W - 1.6,
				h: 0.5,
				align: "center",
				color: MAROON,
				bold: true,
				fontSize: 18,
				charSpacing: 3,
			});
			y += 0.7;
		}

		s.addText(content.title, {
			x: 0.8,
			y,
			w: W - 1.6,
			h: 1.6,
			align: "center",
			color: INK,
			bold: true,
			fontSize: 44,
		});
		y += 1.7;

		if (content.body.length > 0) {
			s.addText(
				content.body.map((line, i) => ({
					text: line,
					options: { breakLine: i < content.body.length - 1 },
				})),
				{
					x: 0.8,
					y,
					w: W - 1.6,
					h: 3,
					align: "center",
					valign: "top",
					color: MUTED,
					fontSize: 22,
					lineSpacingMultiple: 1.2,
				},
			);
		}
	}

	return pptx;
}

/** Sanitize a string for use inside a filename (drop path/reserved chars). */
function fileSafe(s: string): string {
	return s
		.replace(/[/\\?%*:|"<>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Meaningful download name from club + meeting date, e.g.
 * `Acme Toastmasters - 2026-07-15 Agenda.pptx`. Date is the meeting's calendar
 * day in the club timezone.
 */
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
