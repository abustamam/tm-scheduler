// The one place that decides what each slide SAYS and how it's laid out. Both
// renderers — meeting-present.tsx (screen) and deck-to-pptx.ts (.pptx) — consume
// this descriptor, so copy/layout never drifts between them. Pure + unit-tested.

import { APP_LOCALE } from "#/lib/format";
import type { LegendEntry } from "./agenda-runsheet";
import { introducedSuffix, OPEN_LABEL } from "./agenda-runsheet";
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
			/** Free-text lines below everything else, unbulleted, one per entry
			 *  with `""` for a gap — the Table Topics notes (#880). Empty for every
			 *  other slide, and when empty the body renders exactly as before. */
			detail: string[];
	  }
	| { form: "numbered"; items: string[] }
	| {
			/** The next meeting's line-up (#932): who is doing what, and which
			 *  roles are still open. Its own form because it is the one body that
			 *  is a TABLE — two columns of role/holder pairs, with the open ones in
			 *  an accent colour so they read from across the room — and the one
			 *  content body that carries a QR in the descriptor. */
			form: "roster";
			/** Date, time and location, in the club's timezone. */
			when: string;
			/** The role the slide leads with, or null when the meeting runs no
			 *  Toastmaster of the Day. */
			toastmaster: RosterRow | null;
			/** "Meeting #57 · Theme: “Beginnings”", or null when neither is set. */
			meta: string | null;
			/** Roles listed one per row. Every role when they fit; the OPEN ones
			 *  only when they do not — see `rosterBody`. */
			rows: RosterRow[];
			/** Filled roles collapsed into one line when listing them all would
			 *  not fit one slide, else null. */
			filled: string | null;
			/** Open roles collapsed into one line — the last resort, when even
			 *  the open rows alone would not fit. Every open role is still named. */
			openList: string | null;
			qr: { url: string; caption: string } | null;
	  }
	| {
			form: "word";
			word: string;
			definition: string | null;
			example: string | null;
			/** Ready-to-render attribution line ("Presented by the Grammarian ·
			 *  Mona"), or `null` when the club runs no Grammarian (#354). */
			presenter: string | null;
	  };

/**
 * One role on the next-meeting slide (#932). `names` and `open` are separate so
 * a renderer can colour only the open half; either may be null, never both.
 */
export type RosterRow = {
	label: string;
	names: string | null;
	open: string | null;
};

/**
 * How many role rows the next-meeting slide lists before it collapses the
 * filled ones (#932). MEASURED, not chosen, as the largest count that stays
 * legible: rows fill two columns, so they cost height in PAIRS, and against
 * `next-meeting-slide-geometry.test.tsx`'s long-name fixture ten rows need a
 * scale of 0.85 where eleven or twelve need 0.79, under that suite's 0.80
 * floor. It re-measures in a real browser (jsdom does no layout) and fails if
 * this is raised past what fits; `slide-layout-next-meeting.test.ts` fails if
 * it is lowered below ten.
 */
export const MAX_ROSTER_ROWS = 10;
/**
 * How many OPEN roles still get a row each once the filled roles have been
 * collapsed into a line. MEASURED the same way: eight open rows plus that line
 * need 0.85, nine or ten need 0.78. Eight covers the ordinary meeting a week out — most
 * roles still open — which is exactly when a per-role list is worth most. Past
 * it the open roles collapse into a line too, as the overflow fallback only:
 * every one still named, never dropped or grouped into a count.
 */
export const MAX_OPEN_ROWS = 8;

export type SlideLayout =
	| {
			chrome: "splash";
			tone: "light" | "dark";
			headline: string;
			sub: Line[];
			/** The club's own uploaded logo. The two splashes that bookend a
			 *  meeting — the opening title and the closing thank-you — carry it
			 *  when the club has uploaded one (#725); a contest's section bands set
			 *  it null. Required so a new splash kind has to make that choice
			 *  explicitly.
			 *
			 *  Non-null is also what suppresses the word "Toastmasters" on that
			 *  splash: the club's mark REPLACES the word rather than stacking over
			 *  it, so a splash shows one or the other and never both. Both
			 *  renderers decide that from the image they actually have, not from
			 *  this URL — see `deck-to-pptx.ts`'s `renderSplash`. */
			logoUrl: string | null;
	  }
	| { chrome: "content"; header: string; body: Body };

/**
 * The splash logo's box, as PROPORTIONS of the slide frame width (#725).
 *
 * Same argument as `slide-spacing.ts` makes for content-slide spacing, applied
 * to the one element both splashes now lead with: the projected deck sizes in
 * `cqw` (percent of frame width) and the `.pptx` export sizes in inches on a
 * 13.33in frame, so the only thing the two can actually share is the
 * proportion. `cqw()` and `inchesOfWidth()` turn these into either unit.
 *
 * They live here rather than in `slide-spacing.ts` because they are not
 * content-slide spacing: the logo is part of what the splash DESCRIPTOR says,
 * and this module is what both renderers already read that from.
 *
 * BOTH bounds are load-bearing, and neither is a suggestion. A club uploads
 * whatever it has — a square crest, a 10:1 wordmark, a tall banner — so the
 * logo is contained in a `HEIGHT x MAX_WIDTH` box rather than given one fixed
 * dimension: the height alone lets a wide wordmark run off the slide, and the
 * width alone lets a tall one push the headline off the bottom.
 *
 * The values are MEASURED, not chosen. At 1280x720 the opening splash's worst
 * case (a logo, five sub-lines) stands 680px tall against the frame's 720 —
 * about 20px of clearance. Today's arrangement, logo at 9% stacked ABOVE the
 * word, measures 745px and already overflows the frame by 13px top and bottom;
 * dropping the word is what pays for the bigger mark.
 * `splash-logo-geometry.test.ts` re-measures both in a real browser, because
 * jsdom does no layout and would report either arrangement as fine.
 */
export const SPLASH_LOGO_HEIGHT_PCT = 15;
/**
 * The rule that sits under the mark, same units story.
 *
 * It is here rather than inline in either renderer because #725 found them
 * disagreeing about it: the projected splash drew `w-[58cqw]`, the `.pptx`
 * hard-coded `w: 6` on a 13.33in frame, and 6/13.33 is 45%. Nothing noticed,
 * because the two surfaces are never looked at side by side — the same shape
 * `slide-spacing.ts` was created for after #359. Tying the logo's ceiling to
 * "the width of the rule" is only a meaningful sentence once there is ONE rule
 * width, and at 45% the exported deck was overhanging its own rule by 0.87in
 * per side.
 */
export const SPLASH_RULE_WIDTH_PCT = 58;
/**
 * Exactly `SPLASH_RULE_WIDTH_PCT`, so the mark reads as sitting within the
 * splash's own frame rather than spanning past the rule beneath it. Asserted
 * against the RENDERED rule on both surfaces rather than restated as a literal
 * — see `splash-logo-geometry.test.ts` and `deck-to-pptx.test.ts`.
 *
 * It is also the number that sets the BOX's aspect ratio, which is the part
 * that is easy to get wrong. `ClubLogo` locks the height and lets `object-fit:
 * contain` letterbox anything wider than the box, inside a white plate that is
 * visible on the dark closing splash — so a ceiling chosen only for "does not
 * reach the edge" puts white bands around every wordmark wider than
 * `MAX_WIDTH / HEIGHT`. At 58/15 that is 3.9:1, against 46/9 = 5.1:1 on the
 * screen splash before #725 and 4/0.85 = 4.7:1 in the export — the two did not
 * even agree with each other — so the range of shapes that letterbox barely
 * moves, it now moves identically on both surfaces, and every shape gets
 * bigger. Anything wider than that still letterboxes,
 * as it did before; fixing that needs sizing that can see the image's own
 * ratio, which is `ClubLogo`'s to own and shared with the print surfaces.
 */
export const SPLASH_LOGO_MAX_WIDTH_PCT = 58;

const head = (text: string): Line => ({ role: "head", text });
const name = (text: string): Line => ({ role: "name", text });
const muted = (text: string): Line => ({ role: "muted", text });
const strong = (text: string): Line => ({ role: "strong", text });
const SPACER: Line = { role: "spacer" };

function fmtDate(d: Date, tz: string, withWeekday: boolean): string {
	return new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: withWeekday ? "long" : undefined,
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: tz,
	}).format(d);
}
function fmtTime(d: Date, tz: string): string {
	return new Intl.DateTimeFormat(APP_LOCALE, {
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
	// `null`: a name is the headline or the header, and neither depends on the
	// logo. Explicit because the parameter is required — see its docblock on why
	// a defaulted one let a renderer forget the closing splash silently.
	const layout = slideLayout(slide, null);
	return layout.chrome === "content" ? layout.header : layout.headline;
}

/**
 * @param clubLogoUrl The club's own uploaded logo, or null when it has none.
 *   DECK-level context rather than a field on every slide, for the same reason
 *   `deckToPptx` and `MeetingPresent` derive the content footer's club name and
 *   date from the title slide instead of repeating them on each one: the
 *   closing splash carries no club fields of its own, and putting one there
 *   would be a second copy of a value that can then disagree with the first.
 *   Only the splashes read it. Defaults to null so `slideName`, which wants
 *   nothing but the headline, and every test asserting COPY can keep calling
 *   with one argument — a caller that omits it gets a deck with no club logo,
 *   which is exactly what a club without one gets.
 */
export function slideLayout(
	slide: Slide,
	clubLogoUrl: string | null,
): SlideLayout {
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
					//
					// …and WHO (#585), appended to the same line rather than added as a
					// third, so the cue stays one sentence the introducer can read
					// straight off the wall. Empty for an unheld role, which collapses
					// to the two-line slide this has always been.
					head(`Introduces ${slide.toLabel}${introducedSuffix(slide.toNames)}`),
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
				detail: [],
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
				// The master's own topic categories (#880), under everything the
				// deck derives, so the rules of the segment read before its topics.
				detail: slide.notes,
			});
		}
		case "voteTableTopics": {
			// The Best-Table-Topics vote beat's fallback drops the timer's-report
			// clause on the same signal.
			const lines: Line[] = [];
			if (slide.caller) lines.push(callerLine(slide.caller));
			if (slide.hasTimer) lines.push(head("Ask for Table Topics times."));
			lines.push(head("Please Vote for Best Table Topics Speaker:"));
			return content("Vote for Best Table Topics Speaker", {
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
			// `slide.label`, not a literal "Speech Evaluation" (#459). A meeting with
			// three evaluators rendered three ADJACENT jump-grid cells reading the
			// same words, so the grid could not answer "which evaluation is this" for
			// the one run where it is asked. `label` is already `"Evaluation 1"` /
			// `"Evaluation 2"` from `numbered()` — the slide carried it and threw it
			// away.
			//
			// Same fix, same reason, as the sibling multi-instance kind: `case
			// "speech"` reads `slide.label` and that is why the grid shows distinct
			// `First Speech` / `Second Speech` cells.
			//
			// This changes what the ROOM reads, not just the grid — `slideName`
			// returns the header verbatim by design (#446 made it read the real
			// derivation rather than a parallel naming scheme), so the two cannot be
			// disambiguated independently. That is why #446 left this alone: it is a
			// copy decision, and it was taken deliberately rather than smuggled into
			// a one-string bug fix.
			return content(slide.label, { form: "centered", lines });
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
		// The two templated-meeting kinds (#agenda-templates). A section reads as a
		// splash so a contest round announces itself the way the opening and
		// closing do — a content slide with an empty body would read as a beat
		// whose details failed to load. `logoUrl: null` is the deliberate choice
		// the splash type forces, and #725 — which put the crest on the CLOSING
		// splash too — deliberately left it alone: a meeting has two bookends, but
		// a contest has five round dividers, and a mark repeated five times
		// through one meeting is wallpaper rather than identification.
		case "templateSection":
			return {
				chrome: "splash",
				tone: "dark",
				headline: slide.title,
				sub: [],
				logoUrl: null,
			};
		case "templateBeat": {
			// Bullets, like `speech` — the room is reading facts off a wall, not a
			// sentence. Detail first (what this beat IS), then the clock.
			// One bullet per line of the note: the editor's Note is multi-line,
			// and a line break there is a separate point, not a wrap.
			const items: string[] = (slide.detail ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			if (slide.timing) {
				items.push(
					`Signals: ${slide.timing.green} green · ${slide.timing.yellow} yellow · ${slide.timing.red} red`,
				);
				// The ±30s grace window (#357). Spelled out on the wall because in a
				// contest it is the disqualification rule, and the one number the
				// Chief Judge and the room must not learn differently.
				items.push(`Qualifies: ${slide.timing.qualifies}`);
			} else if (slide.minutes > 0) {
				// An untimed beat still has a booked duration; without this the slide
				// would say nothing about how long it runs.
				items.push(`Time: ${slide.minutes} min`);
			}
			return content(slide.label, {
				form: "bullets",
				items,
				link: null,
				note: null,
				// The Table Topics notes (#880) on the governed segment of a materialised
				// meeting — the same `detail` the standard slide carries them in.
				detail: slide.notes,
			});
		}
		case "nextMeeting":
			return content("What’s on tap for next meeting", rosterBody(slide));
		case "thankYou":
			return {
				chrome: "splash",
				tone: "dark",
				headline: "Thank You",
				sub: thankYouSub(slide),
				// #725 reverses the `null` that stood here, and the reason it stood
				// ("the club's logo opens the deck; repeating it on the closing slide
				// would be branding for its own sake") was measuring the wrong thing.
				// This slide is on the wall while the room is standing up, packing up
				// and talking to guests — in wall-time it is the most-looked-at slide
				// in the deck, and it was the one saying nothing about whose meeting
				// this was. It carries the club's mark for the same reason the
				// opening does, and on the same terms: the mark REPLACES the word
				// "Toastmasters", and a club with no logo still gets the word here
				// exactly as before.
				//
				// This does NOT generalise to every splash — see `templateSection`,
				// where the reason for `null` is about repetition and still holds.
				logoUrl: clubLogoUrl,
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

type NextMeetingSlide = Extract<Slide, { kind: "nextMeeting" }>;
type NextMeetingRole = NextMeetingSlide["roles"][number];

/** The call to action an open role carries, in the accent colour. */
function openText(role: NextMeetingRole): string | null {
	if (role.openCount === 0) return null;
	if (role.names.length > 0) return `+${role.openCount} open`;
	return role.openCount === 1
		? "Open: grab it!"
		: `${role.openCount} open: grab one!`;
}

function rosterRow(role: NextMeetingRole): RosterRow {
	return {
		label: role.label,
		names: role.names.length > 0 ? role.names.join(", ") : null,
		open: openText(role),
	};
}

/**
 * The next-meeting slide's body (#932).
 *
 * Every role, filled or open, when they fit. When they do not, three tiers, and
 * the order is the point — the slide exists to get open roles filled, so an
 * open role is the last thing to lose its row and is never dropped:
 *
 *   1. up to `MAX_ROSTER_ROWS` roles: one row each;
 *   2. otherwise, up to `MAX_OPEN_ROWS` open roles: a row each, and the fully
 *      filled roles collapse into one "Also on the agenda" line;
 *   3. otherwise: the open roles collapse into one "Still open" line that names
 *      every one of them, and the filled roles into the other.
 */
function rosterBody(slide: NextMeetingSlide): Body {
	const at = slide.scheduledAt;
	const when = [
		fmtDate(at, slide.timezone, true),
		fmtTime(at, slide.timezone),
		slide.location,
	]
		.filter(Boolean)
		.join(" · ");
	const meta = [
		slide.meetingNumber != null ? `Meeting #${slide.meetingNumber}` : null,
		slide.theme ? `Theme: “${slide.theme}”` : null,
	]
		.filter(Boolean)
		.join(" · ");

	const all = slide.roles;
	const open = all.filter((r) => r.openCount > 0);
	const filledLine = (roles: NextMeetingRole[]) =>
		roles.length > 0
			? `Also on the agenda: ${roles.map((r) => `${r.label}: ${r.names.join(", ")}`).join(" · ")}`
			: null;

	let rows: RosterRow[];
	let filled: string | null = null;
	let openList: string | null = null;
	if (all.length <= MAX_ROSTER_ROWS) {
		rows = all.map(rosterRow);
	} else if (open.length <= MAX_OPEN_ROWS) {
		rows = open.map(rosterRow);
		filled = filledLine(all.filter((r) => r.openCount === 0));
	} else {
		rows = [];
		openList = `Still open: ${open
			.map((r) => (r.openCount > 1 ? `${r.label} (${r.openCount})` : r.label))
			.join(", ")}`;
		filled = filledLine(all.filter((r) => r.names.length > 0));
	}

	return {
		form: "roster",
		when,
		// The same row as every other role, so the lead line and the list below
		// can never describe a filled or open role in different words.
		toastmaster: slide.toastmaster ? rosterRow(slide.toastmaster) : null,
		meta: meta || null,
		rows,
		filled,
		openList,
		qr: slide.signupUrl
			? { url: slide.signupUrl, caption: "Scan to grab a role" }
			: null,
	};
}
