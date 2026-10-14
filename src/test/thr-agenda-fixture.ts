/**
 * THR Speaking Club's 2026-10-10 timing agenda, as the print surfaces receive
 * it — the sheet whose page 2 flowed onto a third page in production.
 *
 * A club template (an "Introductions" beat, sections, a Guest Comments beat)
 * with three speakers, three evaluators and two visiting Toastmasters, so it is
 * longer than `mcf-agenda-fixture.ts` and sits nearer `MIN_FIT_SCALE`'s flow
 * cliff. Transcribed from the printed sheet; the guest suffix is a parameter so
 * a test can measure the sheet with and without a caption.
 */

import type {
	AgendaHeader,
	AgendaOfficer,
	AgendaRoleEntry,
} from "#/components/agenda/meeting-agenda-print";
import type { TimelineRow } from "#/lib/agenda-timing";

export const THR_HEADER: AgendaHeader = {
	clubName: "THR Speaking Club",
	logoUrl: null,
	clubNumber: "28680689",
	district: "District 206",
	mission:
		"At THR Speaking Club, our mission is to build a thriving community that " +
		"fosters self-development and leadership. Through dynamic learning " +
		"experiences, we empower individuals to inspire positive change within " +
		"our club, local community, and beyond.",
	meetingSchedule: "Saturdays at 12PM-1:30PM",
	dateLong: "Saturday, October 10, 2026",
	dateShort: "Sat · Oct 10, 2026",
	timeRange: "12:00 – 1:30 PM",
	theme: "Oops! I Did It Again",
	wordOfTheDay: null,
	location: "THR Youth Lounge",
	announcements: null,
	meetingNumber: null,
};

export const THR_OFFICERS: AgendaOfficer[] = [
	{ office: "President", name: "Rasheed Bustamam" },
	{ office: "VP Education", name: "Durkhanai Roshan" },
	{ office: "VP Membership", name: "Jennifer S Sam" },
	{ office: "VP Public Relations", name: "Open" },
	{ office: "Secretary", name: "Layla Grace Stansfield" },
	{ office: "Treasurer", name: "Ibtesam Salman" },
	{ office: "Sergeant at Arms", name: "Esra Saleh" },
];

export const THR_EXPLAINERS = [
	["Toastmaster of the Day", "Hosts the meeting."],
	["Table Topics Master", "Leads the impromptu speaking segment."],
	["Speaker", "Delivers a prepared speech from your Pathways project."],
	["Evaluator", "Provides structured feedback on your assigned speaker."],
	["General Evaluator", "Oversees meeting quality."],
	["Timer", "Tracks and displays time signals."],
	["Ah-Counter", "Tallies filler words."],
	["Grammarian", "Introduces a Word of the Day."],
].map(([role, description]) => ({ role, description }));

const beat = (
	roleLabel: string,
	holder: string | null,
	detail: string,
	time: string,
	marks: TimelineRow["marks"] = null,
): TimelineRow => ({
	who: holder ? `${roleLabel} · ${holder}` : roleLabel,
	roleLabel,
	holder,
	detail,
	minutes: 1,
	marks,
	time,
});
const handoff = (
	roleLabel: string,
	holder: string,
	detail: string,
): TimelineRow => ({
	...beat(roleLabel, holder, detail, ""),
	minutes: 0,
	handoff: true,
});
const section = (title: string): TimelineRow => ({
	who: title,
	detail: "",
	minutes: 0,
	marks: null,
	section: true,
	time: "",
});

/** Holders as the agenda prints them, given what follows a guest's name. */
export function thrAgenda(captions: { veena: string; david: string }): {
	roles: AgendaRoleEntry[];
	rows: TimelineRow[];
} {
	const VEENA = `Veena Vijayaraj-Kaddidal · ${captions.veena}`;
	const DAVID = `David Ng · ${captions.david}`;
	const LAYLA = "Layla Grace Stansfield";
	const ESRA = "Esra Saleh";

	const TM = "Toastmaster of the Day";
	const TTM = "Table Topics Master";
	const GE = "General Evaluator";
	const eval3 = { green: 2, yellow: 2.5, red: 3 };
	const introEval = (who: string) =>
		handoff(
			TM,
			LAYLA,
			`Introduces the Evaluator: ${who} · asks for the speech objectives and timing`,
		);

	return {
		roles: [
			{ label: TM, name: LAYLA },
			{ label: TTM, name: ESRA },
			{ label: "Speaker 1", name: "Zabihullah Kogyani" },
			{ label: "Evaluator 1", name: "Abdullah Lababidi" },
			{ label: "Speaker 2", name: "Anita Adams" },
			{ label: "Evaluator 2", name: DAVID },
			{ label: "Speaker 3", name: "Fatma Elsawaf" },
			{ label: "Evaluator 3", name: "Hamidah Abdusheikh" },
			{ label: GE, name: VEENA },
			{ label: "Timer", name: null },
			{ label: "Ah-Counter", name: "Zainab Awadallah" },
			{ label: "Grammarian", name: "Durkhanai Roshan" },
		],
		rows: [
			beat("Introductions", null, "", "12:00"),
			section("Opening"),
			beat(
				"Sergeant-at-Arms",
				null,
				"Call to Order · phones silent · introduces the President",
				"12:15",
			),
			beat("President", null, "Opening remarks; welcomes guests", "12:16"),
			beat(TM, LAYLA, "Opens meeting · introduces the theme", "12:17"),
			beat(
				TM,
				LAYLA,
				"Introduces the Timer, Ah-Counter & Grammarian; each explains their " +
					"role · the Grammarian gives the Word of the Day",
				"12:20",
			),
			section("Speeches"),
			handoff(TM, LAYLA, "Introduces the speakers"),
			introEval("Abdullah Lababidi"),
			beat(
				"Speaker 1",
				"Zabihullah Kogyani",
				'"Evaluation & Feedback" · Level 1',
				"12:23",
			),
			introEval(DAVID),
			beat("Speaker 2", "Anita Adams", "Prepared speech", "12:30"),
			introEval("Hamidah Abdusheikh"),
			beat("Speaker 3", "Fatma Elsawaf", '"TBA" · Level 1', "12:37"),
			beat(
				TM,
				LAYLA,
				"Calls for the Timer's report · opens voting for Best Speaker",
				"12:44",
			),
			section("Table Topics"),
			handoff(TM, LAYLA, `Introduces the Table Topics Master: ${ESRA}`),
			beat(
				TTM,
				ESRA,
				"Impromptu topics using the Word of the Day · asks the Timer to " +
					"explain the timing",
				"12:45",
				{ green: 1, yellow: 1.5, red: 2 },
			),
			beat(
				TTM,
				ESRA,
				"Calls for the Timer's report · opens voting for Best Table Topics",
				"1:04",
			),
			section("Evaluations"),
			handoff(TTM, ESRA, `Introduces the General Evaluator: ${VEENA}`),
			handoff(GE, VEENA, "Introduces the speech evaluators"),
			beat(
				GE,
				VEENA,
				"Asks the Timer to explain the timing for an evaluation",
				"1:05",
			),
			beat(
				"Evaluator 1",
				"Abdullah Lababidi",
				"Evaluates Zabihullah Kogyani",
				"1:06",
				eval3,
			),
			beat("Evaluator 2", DAVID, "Evaluates Anita Adams", "1:09", eval3),
			beat(
				"Evaluator 3",
				"Hamidah Abdusheikh",
				"Evaluates Fatma Elsawaf",
				"1:12",
				eval3,
			),
			beat(
				GE,
				VEENA,
				"Calls for the Timer's report · opens voting for Best Evaluator",
				"1:15",
			),
			beat(GE, VEENA, "Evaluates the evaluators", "1:16"),
			beat(
				GE,
				VEENA,
				"Calls for the Timer, Ah-Counter & Grammarian to report",
				"1:18",
			),
			beat(
				GE,
				VEENA,
				"Overall meeting evaluation · returns control to the Toastmaster",
				"1:21",
			),
			section("Closing"),
			beat(
				TM,
				LAYLA,
				"Awards · Best Table Topics, Best Evaluator & Best Speaker · hands " +
					"over to the President",
				"1:23",
			),
			beat("President", null, "Club business · announcements", "1:25"),
			beat(
				"President",
				null,
				"Guest Comments · invites our guests to share their thoughts",
				"1:27",
			),
			beat("President", null, "Adjourns", "1:29"),
		],
	};
}

/** "12:44" + 7 → "12:51". Blank (a handoff or a section) stays blank. */
function shiftClock(time: string, minutes: number): string {
	if (!time) return time;
	const [h = "0", m = "0"] = time.split(":");
	const total = ((Number(h) % 12) * 60 + Number(m) + minutes) % 720;
	const h12 = Math.floor(total / 60) || 12;
	return `${h12}:${String(total % 60).padStart(2, "0")}`;
}

/** Extra speaker / evaluator pairs `thrAgendaLong` adds to THR's three. */
const LONG_PAIRS = [
	{
		speaker: "Priya Raman",
		evaluator: "Marcus Bell",
		detail: '"Ice Breaker" · Level 1',
	},
];

/** Roles a fuller club also fills, which appear on the roster and not as a beat. */
const LONG_EXTRA_ROLES: AgendaRoleEntry[] = [
	{ label: "Ballot Counter", name: "Sana Qureshi" },
	{ label: "Hospitality", name: "Tomas Idowu" },
	{ label: "Photographer", name: null },
];

/**
 * THR's agenda with a fourth speaker / evaluator pair and three more roster-only
 * roles, in the same shape: the longer agenda a club with a full roster prints. THR as it
 * stands sits so near `FitPage`'s flow cliff (`(PAGE_H - 2) / MIN_FIT_SCALE` =
 * 1464px) that WHICH side Editorial lands on depends on the machine's fallback
 * face (it flows on macOS, fits on Linux CI's pinned one), so a test of what
 * happens to an agenda that flows needs this one: it flows in Grid, Editorial
 * and Spacious on both, and still fits Timing on its two sheets. Timing's own
 * overflow is #1227.
 */
export function thrAgendaLong(captions: { veena: string; david: string }): {
	header: AgendaHeader;
	roles: AgendaRoleEntry[];
	rows: TimelineRow[];
} {
	const { roles: baseRoles, rows: baseRows } = thrAgenda(captions);
	const k = LONG_PAIRS.length;
	const TM = "Toastmaster of the Day";
	const LAYLA = "Layla Grace Stansfield";
	const eval3 = { green: 2, yellow: 2.5, red: 3 };

	const roles: AgendaRoleEntry[] = [];
	for (const r of baseRoles) {
		roles.push(r);
		if (r.label === "Evaluator 3") {
			LONG_PAIRS.forEach((p, i) => {
				roles.push({ label: `Speaker ${4 + i}`, name: p.speaker });
				roles.push({ label: `Evaluator ${4 + i}`, name: p.evaluator });
			});
		}
	}

	const rows: TimelineRow[] = [];
	let offset = 0;
	for (const r of baseRows) {
		rows.push({ ...r, time: shiftClock(r.time, offset) });
		if (r.roleLabel === "Speaker 3") {
			LONG_PAIRS.forEach((p, i) => {
				rows.push(
					handoff(
						TM,
						LAYLA,
						`Introduces the Evaluator: ${p.evaluator} · asks for the speech objectives and timing`,
					),
					beat(
						`Speaker ${4 + i}`,
						p.speaker,
						p.detail,
						shiftClock(r.time, offset + 7 * (i + 1)),
					),
				);
			});
			offset += 7 * k;
		}
		if (r.roleLabel === "Evaluator 3") {
			LONG_PAIRS.forEach((p, i) => {
				rows.push(
					beat(
						`Evaluator ${4 + i}`,
						p.evaluator,
						`Evaluates ${p.speaker}`,
						shiftClock(r.time, offset + 3 * (i + 1)),
						eval3,
					),
				);
			});
			offset += 3 * k;
		}
	}
	roles.push(...LONG_EXTRA_ROLES);
	return {
		header: { ...THR_HEADER, timeRange: "12:00 – 1:40 PM" },
		roles,
		rows,
	};
}
