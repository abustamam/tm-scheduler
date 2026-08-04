// The one place that decides what each slide SAYS and how it's laid out. Both
// renderers — meeting-present.tsx (screen) and deck-to-pptx.ts (.pptx) — consume
// this descriptor, so copy/layout never drifts between them. Pure + unit-tested.

import type { LegendEntry } from "./agenda-runsheet";
import { OPEN_LABEL } from "./agenda-runsheet";
import type { HandoffTarget, Slide } from "./agenda-slides";

export type LineRole = "head" | "name" | "strong" | "muted" | "spacer";
/** One rendered line. `text` is absent for `spacer`. */
export type Line = { role: LineRole; text?: string };

export type Body =
	| { form: "centered"; lines: Line[] }
	| {
			form: "bullets";
			items: string[];
			link: string | null;
			/** A muted line under the bullets, for context rather than instruction —
			 *  the Word of the Day's definition on the Table Topics slide (#355).
			 *  Set it on the item it belongs to by putting that item last. */
			note: string | null;
	  }
	| { form: "numbered"; items: string[] }
	| {
			form: "word";
			word: string;
			definition: string | null;
			example: string | null;
			/** Ready-to-render attribution line ("Presented by the Grammarian ·
			 *  Mona"), or `null` when the club runs no Grammarian (#354). */
			presenter: string | null;
	  };

export type SlideLayout =
	| {
			chrome: "splash";
			tone: "light" | "dark";
			headline: string;
			sub: Line[];
			/** Only the opening title splash carries one; every other splash
			 *  (thank-you, section breaks) leaves it null. */
			logoUrl?: string | null;
	  }
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

/** The segment leader who calls a vote (#363), as the vote slides show them —
 *  the same "Role · Name" the printed row's `who` column carries, so the two
 *  surfaces credit the same person in the same words.
 *
 *  `strong`, not `muted`: it is the only place a human's name leads a slide, and
 *  `muted` (2.5cqw) would make it the smallest line on a deck read off a
 *  projector. `strong` (2.8cqw semibold) keeps it subordinate to the `head`
 *  instructions it attributes without making the name the hardest thing to
 *  read. */
const callerLine = (caller: LegendEntry): Line =>
	strong(`${caller.role} · ${caller.name}`);

/**
 * A hand-off's header, by the segment it hands to (#363).
 *
 * The overview grid names a slide by its header — `slideName` above returns it
 * verbatim — so one shared "Hand-off" would put five indistinguishable rows in
 * the one place a jump grid exists to help, in an issue whose whole point is
 * removing ambiguity about who does what. The
 * suffix names the SEGMENT, short enough to read in a grid cell; the body still
 * spells out the full prose target.
 *
 * Keyed on `to`, which is what tells them apart — four targets covering five
 * hand-offs. The two INTO the General Evaluator (MCF's opening one and the one
 * out of Table Topics) are deliberately indistinguishable here: they are the
 * same transition, and the run sheet concedes it by minting separate
 * `geOpeningHandoff`/`geEvaluationHandoff` ids for the beats instead. An
 * unmapped target falls back to the bare header rather than throwing —
 * `HandoffTarget` makes that unreachable through the type, but a worse grid
 * label is still not worth a deck that will not render mid-meeting.
 */
const HANDOFF_HEADER: Record<HandoffTarget, string> = {
	"the speakers": "Hand-off — Speakers",
	"the Table Topics Master": "Hand-off — Table Topics",
	"the General Evaluator": "Hand-off — General Evaluator",
	"the speech evaluators": "Hand-off — Evaluators",
};

/** Credit for the Word of the Day (#354). The slide sits inside the
 *  Toastmaster's opening, so it names the role that actually presents it — the
 *  Grammarian, under the club's own name for it. An unclaimed Grammarian is
 *  still the Grammarian's, so the role is credited without the placeholder;
 *  a club that runs no Grammarian gets no line rather than a credit to a role
 *  it never configured. */
function presenterLine(presenter: LegendEntry | null): string | null {
	if (presenter == null) return null;
	return presenter.name === OPEN_LABEL
		? `Presented by the ${presenter.role}`
		: `Presented by the ${presenter.role} · ${presenter.name}`;
}

/** The one name a slide answers to outside the slide itself: what the audience
 *  reads off it, reused verbatim for the jump-to-slide grid's cells (#360) and
 *  for anything else that has to refer to a slide in one line. Lives here beside
 *  `slideLayout` rather than in the presenter, so the cross-kind uniqueness the
 *  grid depends on can be asserted against the real derivation instead of a copy
 *  of it (#446). Splash slides carry no header, so they answer to their headline. */
export function slideName(slide: Slide): string {
	const layout = slideLayout(slide);
	return layout.chrome === "content" ? layout.header : layout.headline;
}

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
			return {
				chrome: "splash",
				tone: "light",
				headline: slide.clubName,
				sub,
				logoUrl: slide.logoUrl,
			};
		}
		case "toastmaster":
			return content("Toastmaster", {
				form: "centered",
				lines: [head(slide.name)],
			});
		case "handoff":
			// Two lines, both `head`: the cue is the whole slide, so neither half is
			// subordinate to the other. The holder is named the way the printed
			// hand-off band names them — including the "— open —" placeholder for an
			// enabled-but-unclaimed role, since suppressing it here would drop a cue
			// the printed agenda keeps.
			return content(HANDOFF_HEADER[slide.to] ?? "Hand-off", {
				form: "centered",
				lines: [
					head(`${slide.from.role} · ${slide.from.name}`),
					// Capital I: the centered body separates the two lines with the gap
					// it gives independent statements, so a lower-case second line reads
					// as a sentence broken in half. It also matches the printed band,
					// which prints the run sheet's own "Introduces the speakers".
					// `toLabel`, not `to`: `to` is the identity that keys the jump grid
					// above and must stay canonical, while this line is what the room
					// reads and follows the club's own name for the role (#462).
					head(`Introduces ${slide.toLabel}`),
				],
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
			// The owner comes off the slide, exactly as `functionaryIntro`'s does:
			// it is the General Evaluator at most clubs and the Toastmaster of the
			// Day at a club that runs no GE (#363). Hardcoding "General Evaluator:"
			// here is what made a Toastmaster-covered slide announce a role nobody
			// in the room held.
			return content("Functionary Reports", {
				form: "centered",
				lines: [
					head(`${slide.owner}:`),
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
				presenter: presenterLine(slide.presenter),
			});
		case "speech": {
			const items = [`Speaker: ${slide.speaker}`];
			if (slide.title) items.push(`Speech Title: “${slide.title}”`);
			if (slide.projectLevel) items.push(`Project: ${slide.projectLevel}`);
			items.push(`Time: ${slide.time}`);
			return content(slide.label, {
				form: "bullets",
				items,
				link: slide.link,
				note: null,
			});
		}
		case "voteSpeaker": {
			// Timer-aware like the other two vote slides: the Best-Speaker vote
			// beat's fallback drops the same clause (#367), so a club with no Timer
			// prints "Toastmaster · Opens voting for Best Speaker" and must not be
			// told to call for a report from a role nobody holds.
			const lines: Line[] = [];
			// The segment leader who calls the report and the vote (#363), first and
			// below `head`: it is attribution — whose cue this is — not one of the
			// instructions the room is being read.
			if (slide.caller) lines.push(callerLine(slide.caller));
			if (slide.hasTimer) lines.push(head("Ask for speaking time."));
			lines.push(
				head("Please Vote for Best Speaker:"),
				...slide.names.map(name),
			);
			return content("Vote for Best Speaker", { form: "centered", lines });
		}
		case "tableTopics": {
			const items = [
				`Table Topic Master: ${slide.master}`,
				"Impromptu Speeches",
				`Speaker time: ${slide.timing}`,
			];
			// Last, so the definition below it reads as belonging to it — and so the
			// word is the line the room's eye ends on for the whole segment (#355).
			if (slide.word) items.push(`Word of the Day: “${slide.word}”`);
			return content("Table Topics", {
				form: "bullets",
				items,
				link: null,
				// Muted, not a fourth bullet: the definition is context for working
				// the word in, not another instruction to the Table Topics Master.
				note: slide.word ? slide.definition : null,
			});
		}
		case "voteTableTopics": {
			// The Best-Table-Topics vote beat's fallback drops the timer's-report
			// clause on the same signal.
			const lines: Line[] = [];
			if (slide.caller) lines.push(callerLine(slide.caller));
			if (slide.hasTimer) lines.push(head("Ask for Table Topics times."));
			lines.push(head("Please Vote for Best Table Topic Speaker:"));
			return content("Vote for Best Table Topic", {
				form: "centered",
				lines,
			});
		}
		case "evaluatorEvaluation":
			// Owner off the slide, for the same reason as the reports slide above.
			return content("Evaluation of the Evaluators", {
				form: "centered",
				lines: [
					head(`${slide.owner}:`),
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
			// The Best-Evaluator vote beat's fallback, likewise.
			const lines: Line[] = [];
			if (slide.caller) lines.push(callerLine(slide.caller));
			if (slide.hasTimer) lines.push(head("Ask for timer’s report:"));
			lines.push(
				head("Please Vote for Best Evaluator:"),
				...slide.names.map(name),
			);
			// Names its own segment, like its two sibling votes (#446). It used to
			// return the `evaluation` slide's "Speech Evaluation", so a meeting with
			// three evaluators put four consecutive identical cells in the
			// jump-to-slide grid — `slideName` renders this header verbatim — and
			// the one that was actually the vote could only be found by counting.
			return content("Vote for Best Evaluator", { form: "centered", lines });
		}
		case "generalEvaluation":
			// The header names the SEGMENT; this line names the ROLE giving it — the
			// General Evaluator, or the Toastmaster of the Day covering it at a club
			// that runs no GE (#363). The holder's name is deliberately not shown:
			// this slide has never named them, and the run sheet's matching row
			// already does — so the slide carries no `name` to show.
			return content("General Evaluation", {
				form: "centered",
				lines: [
					head(slide.owner),
					head("Closing Remarks"),
					strong(`Time: ${slide.time}`),
				],
			});
		case "awards":
			return content("Award Presentation", {
				form: "numbered",
				items: slide.categories,
			});
		case "guestComments":
			// Addressed to the room rather than to named individuals (#352): the
			// slide is up while the President turns to whoever is visiting, and a
			// list built from the recorded guests would silently leave out anyone
			// who simply walked in.
			return content("Guest Comments", {
				form: "centered",
				lines: [
					head("We’d love to hear from our guests."),
					muted("How did you find the meeting today?"),
				],
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
