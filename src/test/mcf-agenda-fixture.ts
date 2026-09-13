/**
 * MCF's real 2026-08-13 agenda, as the print surfaces receive it.
 *
 * One REAL club meeting rather than a generated one, for the reason
 * `print-density.test.tsx` gives about its own copy: a synthetic fixture has to
 * guess how often a club runs the same presenter through consecutive beats, and
 * that frequency is what decides the sheet's height. Anything measuring how
 * close a one-page layout sits to `MIN_FIT_SCALE`'s flow cliff has to measure
 * the agenda that actually prints.
 *
 * DUPLICATED, and knowingly. `print-density.test.tsx` carries the same agenda
 * inline and predates this module (#717 could not edit that file). The two are
 * the same meeting transcribed twice, so they can drift — #719 updated one of
 * them, and the next such change should fold that file onto this module rather
 * than transcribe the meeting a third time.
 */

import type {
	AgendaHeader,
	AgendaOfficer,
	AgendaRoleEntry,
} from "#/components/agenda/meeting-agenda-print";
import type { TimelineRow } from "#/lib/agenda-timing";

export const MCF_HEADER: AgendaHeader = {
	clubName: "MCF Toastmasters",
	logoUrl: null,
	clubNumber: "1234567",
	district: "District 39",
	mission:
		"At Muslim Community of Folsom, (MCF) Toastmasters, our mission is to " +
		"build a thriving community that fosters self-development and leadership. " +
		"Through dynamic learning experiences, we empower individuals to inspire " +
		"positive change within our club, local community, and beyond.",
	meetingSchedule: "2nd & 4th Thursdays, 6:45-7:45",
	dateLong: "Thursday, August 13, 2026",
	dateShort: "Thu · Aug 13, 2026",
	timeRange: "6:45 – 7:45 PM",
	theme: "Growth",
	wordOfTheDay: "Ebullient",
	location: "MCF Conference Room",
	announcements: "Dues are due!",
	meetingNumber: null,
};

export const MCF_OFFICERS: AgendaOfficer[] = [
	{ office: "President", name: "Schinthia Islam" },
	{ office: "VP Education", name: "Rasheed Bustamam" },
	{ office: "VP Membership", name: "Faisal Ali" },
	{ office: "VP Public Relations", name: "Open" },
	{ office: "Secretary", name: "Sudheer Isanaka" },
	{ office: "Treasurer", name: "Jagpal Singh" },
	{ office: "Sergeant at Arms", name: "Muhammad Ali" },
];

export const MCF_ROLES: AgendaRoleEntry[] = [
	{ label: "Toastmaster of the Day", name: "Muhammad Ali" },
	{ label: "General Evaluator", name: "Faisal Ali" },
	{ label: "Table Topics Master", name: "Rasheed Bustamam" },
	{ label: "Speaker 1", name: "Jagpal Singh" },
	{ label: "Evaluator 1", name: "Rasheed Bustamam" },
	{ label: "Speaker 2", name: "Sudheer Isanaka" },
	{ label: "Evaluator 3", name: "Riyaz Mohammed" },
	{ label: "Timer", name: "Riyaz Mohammed" },
	{ label: "Ah-Counter", name: "Mahbuba Khan" },
	{ label: "Grammarian", name: "Diego Nuci" },
	{ label: "Vote Counter", name: "Rasheed Bustamam" },
];

/** The four role blurbs `TimingLayout` prints on its page 1 — the sheet #717
 *  put a ballot QR on. Sized like the real thing: the explainer block is the
 *  tallest thing on that sheet, and with four of them the sheet measures 914px
 *  of the page's 1056 — the headroom that lets the new QR cost no scale. */
export const MCF_EXPLAINERS = [
	{
		role: "Timer",
		description:
			"Times every segment and reports the times back to the Toastmaster.",
	},
	{
		role: "Ah-Counter",
		description:
			"Counts filler words and crutch phrases, and reports the tally.",
	},
	{
		role: "Grammarian",
		description:
			"Gives the Word of the Day and reports on the language used well.",
	},
	{
		role: "Vote Counter",
		description: "Collects the ballots and tallies them for the awards.",
	},
];

const TM = "Toastmaster of the Day · Muhammad Ali";
const GE = "General Evaluator · Faisal Ali";
const TTM = "Table Topics Master · Rasheed Bustamam";

function handoff(
	who: string,
	roleKey: string,
	detail: string,
	time: string,
): TimelineRow {
	return { who, roleKey, detail, minutes: 0, marks: null, handoff: true, time };
}

/** MCF's 2026-08-13 run of show: 20 timed beats and 10 hand-offs, in page order.
 *  Ten because two of them are the per-speech preambles introducing each
 *  evaluator (#719), which the speaker beat emits inside its own expansion. */
export const MCF_ROWS: TimelineRow[] = [
	{
		who: "Sergeant-at-Arms",
		detail: "Call to Order · phones silent · introduces the President",
		minutes: 1,
		marks: null,
		time: "6:45",
	},
	{
		who: "President",
		detail: "Opening remarks; welcomes guests",
		minutes: 1,
		marks: null,
		time: "6:46",
	},
	{
		who: TM,
		roleKey: "toastmaster_of_the_day",
		detail: "Opens meeting · introduces the theme",
		minutes: 3,
		marks: null,
		time: "6:47",
	},
	handoff(
		TM,
		"toastmaster_of_the_day",
		"Introduces the General Evaluator: Faisal Abdul-Rahman Al-Mansoori",
		"6:50",
	),
	{
		who: GE,
		roleKey: "general_evaluator",
		detail:
			"Introduces the Timer, Ah-Counter, Grammarian & Vote Counter; each " +
			"explains their role · the Grammarian gives the Word of the Day",
		minutes: 3,
		marks: null,
		time: "6:50",
	},
	handoff(TM, "toastmaster_of_the_day", "Introduces the speakers", "6:53"),
	handoff(
		TM,
		"toastmaster_of_the_day",
		"Introduces the Evaluator: Rasheed Bustamam · asks for the speech " +
			"objectives and timing",
		"6:53",
	),
	{
		who: "Speaker 1 · Jagpal Singh",
		roleKey: "speaker",
		detail: '"Corporate IT Leadership - Reshaped by AI" · Level 4',
		minutes: 7,
		marks: { green: 5, yellow: 6, red: 7 },
		time: "6:53",
	},
	handoff(
		TM,
		"toastmaster_of_the_day",
		"Introduces the Evaluator: Riyaz Mohammed · asks for the speech " +
			"objectives and timing",
		"7:00",
	),
	{
		who: "Speaker 2 · Sudheer Isanaka",
		roleKey: "speaker",
		detail: '"AI & Us - The human side of Artificial intelligence" · Level 5',
		minutes: 20,
		marks: { green: 15, yellow: 17.5, red: 20 },
		time: "7:00",
	},
	{
		who: TM,
		roleKey: "toastmaster_of_the_day",
		detail: "Calls for the Timer's report · opens voting for Best Speaker",
		minutes: 1,
		marks: null,
		time: "7:20",
	},
	handoff(
		TM,
		"toastmaster_of_the_day",
		"Introduces the Table Topics Master: Rasheed Bustamam-Wickramasinghe",
		"7:21",
	),
	{
		who: TTM,
		roleKey: "table_topics_master",
		detail:
			"Impromptu topics using the Word of the Day · asks the Timer to " +
			"explain the timing",
		minutes: 5,
		marks: { green: 1, yellow: 1.5, red: 2 },
		flex: true,
		handoff: false,
		time: "7:21",
	},
	{
		who: TTM,
		roleKey: "table_topics_master",
		detail: "Calls for the Timer's report · opens voting for Best Table Topics",
		minutes: 1,
		marks: null,
		time: "7:26",
	},
	handoff(
		TTM,
		"table_topics_master",
		"Introduces the General Evaluator: Faisal Abdul-Rahman Al-Mansoori",
		"7:27",
	),
	handoff(GE, "general_evaluator", "Introduces the speech evaluators", "7:27"),
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Asks the Timer to explain the timing for an evaluation",
		minutes: 1,
		marks: null,
		time: "7:27",
	},
	{
		who: "Evaluator 1 · Rasheed Bustamam",
		roleKey: "evaluator",
		detail: "Evaluates Jagpal Singh",
		minutes: 3,
		marks: { green: 2, yellow: 2.5, red: 3 },
		time: "7:28",
	},
	{
		who: "Evaluator 2 · Riyaz Mohammed",
		roleKey: "evaluator",
		detail: "Evaluates Sudheer Isanaka",
		minutes: 3,
		marks: { green: 2, yellow: 2.5, red: 3 },
		time: "7:31",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Calls for the Timer's report · opens voting for Best Evaluator",
		minutes: 1,
		marks: null,
		time: "7:34",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Evaluates the evaluators",
		minutes: 2,
		marks: null,
		time: "7:35",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail:
			"Calls for the Timer, Ah-Counter, Grammarian & Vote Counter to report",
		minutes: 3,
		marks: null,
		time: "7:37",
	},
	{
		who: GE,
		roleKey: "general_evaluator",
		detail: "Overall meeting evaluation · returns control to the Toastmaster",
		minutes: 2,
		marks: null,
		time: "7:40",
	},
	{
		who: TM,
		roleKey: "toastmaster_of_the_day",
		detail:
			"Awards · Best Table Topics, Best Evaluator & Best Speaker · hands " +
			"over to the President",
		minutes: 2,
		marks: null,
		time: "7:42",
	},
	{
		who: "President",
		detail: "Club business · announcements",
		minutes: 2,
		marks: null,
		time: "7:44",
	},
	{
		who: "President",
		detail: "Guest Comments · invites our guests to share their thoughts",
		minutes: 2,
		marks: null,
		time: "7:46",
	},
	{
		who: "President",
		detail: "Adjourns",
		minutes: 1,
		marks: null,
		time: "7:48",
	},
];

/** An absolute ballot URL of the length the app really mints: an origin plus
 *  `/club/<slug>/meeting/<key>/vote`. The length is the point — it is what puts
 *  the encoded value at QR version 3-4, which is why the printed edge matters. */
export const MCF_BALLOT_URL =
	"https://gavelup.app/club/mcf-toastmasters/meeting/2026-08-13/vote";
