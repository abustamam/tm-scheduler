// The one place that decides what each slide SAYS and how it's laid out. Both
// renderers — meeting-present.tsx (screen) and deck-to-pptx.ts (.pptx) — consume
// this descriptor, so copy/layout never drifts between them. Pure + unit-tested.

import type { LegendEntry } from "./agenda-runsheet";
import { OPEN_LABEL } from "./agenda-runsheet";
import type { Slide } from "./agenda-slides";

export type LineRole = "head" | "name" | "strong" | "muted" | "spacer";
/** One rendered line. `text` is absent for `spacer`. */
export type Line = { role: LineRole; text?: string };

export type Body =
	| { form: "centered"; lines: Line[] }
	| { form: "bullets"; items: string[]; link: string | null }
	| { form: "numbered"; items: string[] }
	| {
			form: "word";
			word: string;
			definition: string | null;
			example: string | null;
	  };

export type SlideLayout =
	| { chrome: "splash"; tone: "light" | "dark"; headline: string; sub: Line[] }
	| { chrome: "content"; header: string; body: Body };

const head = (text: string): Line => ({ role: "head", text });
const name = (text: string): Line => ({ role: "name", text });
const muted = (text: string): Line => ({ role: "muted", text });
const strong = (text: string): Line => ({ role: "strong", text });
const SPACER: Line = { role: "spacer" };

function fmtDate(d: Date, tz: string, withWeekday: boolean): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: withWeekday ? "long" : undefined,
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: tz,
	}).format(d);
}
function fmtTime(d: Date, tz: string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		timeZone: tz,
	}).format(d);
}

/** The footer's compact date (month day, year), shared by both renderers. */
export function footerDate(d: Date, tz: string): string {
	return fmtDate(d, tz, false);
}

const content = (header: string, body: Body): SlideLayout => ({
	chrome: "content",
	header,
	body,
});

/** Functionaries with a holder. An open role is dropped from the projected list
 *  on both functionary slides — there is nobody to introduce, and nobody to
 *  call on for a report. */
const filledTeam = (team: LegendEntry[]): LegendEntry[] =>
	team.filter((t) => t.name !== OPEN_LABEL);

export function slideLayout(slide: Slide): SlideLayout {
	switch (slide.kind) {
		case "title": {
			const sub: Line[] = [];
			if (slide.district) sub.push(muted(slide.district));
			if (slide.clubNumber) sub.push(muted(`Club #${slide.clubNumber}`));
			if (slide.meetingNumber != null)
				sub.push(muted(`Meeting #${slide.meetingNumber}`));
			sub.push(muted(fmtDate(slide.scheduledAt, slide.timezone, true)));
			sub.push(
				muted(`Start time: ${fmtTime(slide.scheduledAt, slide.timezone)}`),
			);
			return { chrome: "splash", tone: "light", headline: slide.clubName, sub };
		}
		case "toastmaster":
			return content("Toastmaster", {
				form: "centered",
				lines: [head(slide.name)],
			});
		case "toastmasterIntro": {
			const lines: Line[] = [];
			if (slide.theme)
				lines.push(head("Meeting Theme:"), head(`“${slide.theme}”`));
			if (slide.theme && slide.word) lines.push(SPACER);
			if (slide.word)
				lines.push(head("Word of the Day:"), head(`“${slide.word}”`));
			return content("Toastmaster Intro", { form: "centered", lines });
		}
		case "functionaryIntro": {
			// The header names the segment, not its owner: the owner varies by club
			// (#367) and "Toastmaster of the Day Intro" would collide with the
			// "Toastmaster Intro" (theme + Word of the Day) slide above.
			const lines: Line[] = [head(`${slide.owner}:`), head(slide.name)];
			const teamMembers = filledTeam(slide.team);
			if (teamMembers.length > 0) {
				lines.push(
					muted(
						`Team — ${teamMembers.map((t) => `${t.role}: ${t.name}`).join(", ")}`,
					),
				);
			}
			return content("Functionaries", { form: "centered", lines });
		}
		case "functionaryReports":
			return content("Functionary Reports", {
				form: "centered",
				lines: [
					head("General Evaluator:"),
					head(slide.name),
					...filledTeam(slide.team).map((t) => name(`${t.role}: ${t.name}`)),
				],
			});
		case "wordOfDay":
			return content("Word of the Day", {
				form: "word",
				word: slide.word,
				definition: slide.definition,
				example: slide.example,
			});
		case "speech": {
			const items = [`Speaker: ${slide.speaker}`];
			if (slide.title) items.push(`Speech Title: “${slide.title}”`);
			if (slide.projectLevel) items.push(`Project: ${slide.projectLevel}`);
			items.push(`Time: ${slide.time}`);
			return content(slide.label, { form: "bullets", items, link: slide.link });
		}
		case "voteSpeaker": {
			// Timer-aware like the other two vote slides: the run sheet's beat-6
			// fallback drops the same clause (#367), so a club with no Timer prints
			// "Toastmaster · Vote Best Speaker" and must not be told to call for a
			// report from a role nobody holds.
			const lines: Line[] = slide.hasTimer
				? [head("Ask for speaking time.")]
				: [];
			lines.push(
				head("Please Vote for Best Speaker:"),
				...slide.names.map(name),
			);
			return content("Vote for Best Speaker", { form: "centered", lines });
		}
		case "tableTopics":
			return content("Table Topics", {
				form: "bullets",
				items: [
					`Table Topic Master: ${slide.master}`,
					"Impromptu Speeches",
					`Speaker time: ${slide.timing}`,
				],
				link: null,
			});
		case "voteTableTopics": {
			// Beat 8's fallback drops the timer's-report clause on the same signal.
			const lines: Line[] = slide.hasTimer
				? [head("Ask for Table Topics times.")]
				: [];
			lines.push(head("Please Vote for Best Table Topic Speaker:"));
			return content("Vote for Best Table Topic", {
				form: "centered",
				lines,
			});
		}
		case "evaluatorEvaluation":
			return content("Evaluation of the Evaluators", {
				form: "centered",
				lines: [
					head("General Evaluator:"),
					head(slide.name),
					strong(`Time: ${slide.time}`),
				],
			});
		case "evaluation": {
			const lines: Line[] = [head(`Evaluator: ${slide.evaluator}`)];
			if (slide.speaker) lines.push(head(`Speaker: ${slide.speaker}`));
			lines.push(strong(`Time: ${slide.time}`));
			return content("Speech Evaluation", { form: "centered", lines });
		}
		case "voteEvaluator": {
			// Beat 10's fallback, likewise.
			const lines: Line[] = slide.hasTimer
				? [head("Ask for timer’s report:")]
				: [];
			lines.push(
				head("Please Vote for Best Evaluator:"),
				...slide.names.map(name),
			);
			return content("Speech Evaluation", { form: "centered", lines });
		}
		case "generalEvaluation":
			return content("General Evaluation", {
				form: "centered",
				lines: [
					head("General Evaluator"),
					head("Closing Remarks"),
					strong(`Time: ${slide.time}`),
				],
			});
		case "awards":
			return content("Award Presentation", {
				form: "numbered",
				items: slide.categories,
			});
		case "reminders":
			return content("Announcements", {
				form: "centered",
				lines: slide.text
					.split("\n")
					.map((t) => (t.trim() ? muted(t.trim()) : SPACER)),
			});
		case "thankYou":
			return {
				chrome: "splash",
				tone: "dark",
				headline: "Thank You",
				sub: thankYouSub(slide),
			};
	}
	return ((_x: never): never => {
		throw new Error("unreachable");
	})(slide);
}

function thankYouSub(slide: Extract<Slide, { kind: "thankYou" }>): Line[] {
	const sub: Line[] = [
		muted("CONGRATULATIONS on another great learning session!"),
	];
	if (slide.nextMeetingAt) {
		sub.push(
			SPACER,
			muted("Next Meeting:"),
			strong(fmtDate(slide.nextMeetingAt, slide.timezone, true)),
			strong(fmtTime(slide.nextMeetingAt, slide.timezone)),
		);
	} else if (slide.meetingSchedule) {
		sub.push(muted(`We meet ${slide.meetingSchedule}`));
	}
	return sub;
}
