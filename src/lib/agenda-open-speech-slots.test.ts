/**
 * An open speech slot reserves no time (#1479).
 *
 * Every test carries its card: `protects=…; fails_when=…; no_claim=…`.
 */
import { describe, expect, it } from "vitest";
import { contestFixture } from "#/test/contest-fixture";
import { withBeatIds } from "#/test/template-beat-ids";
import { materialiseRunOfShow } from "./agenda-materialise";
import { agendaRunSheet } from "./agenda-run-sheet";
import {
	type AgendaRow,
	type AgendaSlot,
	applyFlex,
	buildRunOfShow,
	expandRunSheet,
	OPEN_LABEL,
	TABLE_TOPICS_MAX,
} from "./agenda-runsheet";
import {
	buildTemplateRows,
	buildTemplateRowsWithSource,
	type TemplateBeatRow,
	type TemplateRoleRow,
} from "./agenda-template-rows";

function slot(
	id: string,
	roleKey: string,
	roleName: string,
	assigneeName: string | null,
	over: Partial<AgendaSlot> = {},
): AgendaSlot {
	return {
		id,
		roleKey,
		roleName,
		category: "leadership",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

const speaker = (i: number, name: string | null) =>
	slot(`sp${i}`, "speaker", "Speaker", name, {
		isSpeakerRole: true,
		category: "speaker",
		slotIndex: i,
		minMinutes: 5,
		maxMinutes: 7,
	});

const evaluator = (i: number, name: string | null, evaluates: string | null) =>
	slot(`ev${i}`, "evaluator", "Evaluator", name, {
		isSpeakerRole: true,
		category: "evaluator",
		slotIndex: i,
		evaluatesSlotId: evaluates,
	});

/** Three speakers, each with a linked evaluator. `names[i]` null = open. */
function club(
	names: (string | null)[] = ["Ann", "Bea", "Cy"],
	extra: AgendaSlot[] = [],
): AgendaSlot[] {
	return [
		slot("sa", "sergeant_at_arms", "Sergeant-at-Arms", "Sam"),
		slot("pr", "president", "President", "Pat"),
		slot("tm", "toastmaster_of_the_day", "Toastmaster of the Day", "Tia"),
		slot("ge", "general_evaluator", "General Evaluator", "Gil"),
		slot("tt", "table_topics_master", "Table Topics Master", "Tom"),
		...names.map((n, i) => speaker(i, n)),
		...names.map((_, i) => evaluator(i, `Eval${i}`, `sp${i}`)),
		slot("ti", "timer", "Timer", "Tim", { category: "functionary" }),
		slot("gr", "grammarian", "Grammarian", "Gra", { category: "functionary" }),
		slot("ah", "ah_counter", "Ah-Counter", "Ahh", { category: "functionary" }),
		...extra,
	];
}

const ROLES: TemplateRoleRow[] = [
	{ key: "sergeant_at_arms", name: "Sergeant-at-Arms", isSpeakerRole: false },
	{ key: "president", name: "President", isSpeakerRole: false },
	{
		key: "toastmaster_of_the_day",
		name: "Toastmaster of the Day",
		isSpeakerRole: false,
	},
	{ key: "general_evaluator", name: "General Evaluator", isSpeakerRole: false },
	{
		key: "table_topics_master",
		name: "Table Topics Master",
		isSpeakerRole: false,
	},
	{ key: "speaker", name: "Speaker", isSpeakerRole: true },
	{ key: "evaluator", name: "Evaluator", isSpeakerRole: true },
	{ key: "timer", name: "Timer", isSpeakerRole: false },
	{ key: "grammarian", name: "Grammarian", isSpeakerRole: false },
	{ key: "ah_counter", name: "Ah-Counter", isSpeakerRole: false },
];

const sum = (rows: AgendaRow[]) => rows.reduce((n, r) => n + r.minutes, 0);
const speechRows = (rows: AgendaRow[]) =>
	rows.filter((r) => r.slotId?.startsWith("sp"));
const evalRows = (rows: AgendaRow[]) =>
	rows.filter((r) => r.roleKey === "evaluator");
const handoffs = (rows: AgendaRow[]) => rows.filter((r) => r.handoff);

const code = (slots: AgendaSlot[], mode?: "omit" | "zero") =>
	expandRunSheet(
		slots,
		buildRunOfShow({ geIntroducesFunctionaries: false }),
		mode,
	);
const seeds = () => withBeatIds(materialiseRunOfShow(false, null));
const template = (slots: AgendaSlot[], mode?: "omit" | "zero") =>
	buildTemplateRows(seeds(), ROLES, slots, mode).filter(
		(r) => r.section !== true,
	);

/** Today's rows for `club()` booked-only, from origin/main's builders at
 *  67f978ec (both paths print the same rows): [who, minutes, detail]. */
const BOOKED_GOLDEN: [string, number, string][] = [
	[
		"Sergeant-at-Arms",
		1,
		"Call to Order · phones silent · introduces the President",
	],
	["President", 1, "Opening remarks; welcomes guests"],
	["Toastmaster of the Day · Tia", 3, "Opens meeting · introduces the theme"],
	[
		"Toastmaster of the Day · Tia",
		3,
		"Introduces the Timer, Grammarian & Ah-Counter; each explains their role · the Grammarian gives the Word of the Day",
	],
	["Toastmaster of the Day · Tia", 0, "Introduces the speakers"],
	[
		"Toastmaster of the Day · Tia",
		0,
		"Introduces the Evaluator: Eval0 · asks for the speech objectives and timing",
	],
	["Speaker 1 · Ann", 7, "Prepared speech"],
	[
		"Toastmaster of the Day · Tia",
		0,
		"Introduces the Evaluator: Eval1 · asks for the speech objectives and timing",
	],
	["Speaker 2 · Bea", 7, "Prepared speech"],
	[
		"Toastmaster of the Day · Tia",
		0,
		"Introduces the Evaluator: Eval2 · asks for the speech objectives and timing",
	],
	["Speaker 3 · Cy", 7, "Prepared speech"],
	[
		"Toastmaster of the Day · Tia",
		1,
		"Calls for the Timer's report · calls for votes for Best Speaker",
	],
	[
		"Toastmaster of the Day · Tia",
		0,
		"Introduces the Table Topics Master: Tom",
	],
	[
		"Table Topics Master · Tom",
		10,
		"Impromptu topics using the Word of the Day · asks the Timer to explain the timing",
	],
	[
		"Table Topics Master · Tom",
		1,
		"Calls for the Timer's report · calls for votes for Best Table Topics",
	],
	["Table Topics Master · Tom", 0, "Introduces the General Evaluator: Gil"],
	["General Evaluator · Gil", 0, "Introduces the speech evaluators"],
	[
		"General Evaluator · Gil",
		1,
		"Asks the Timer to explain the timing for an evaluation",
	],
	["Evaluator 1 · Eval0", 3, "Evaluates Speaker 1"],
	["Evaluator 2 · Eval1", 3, "Evaluates Speaker 2"],
	["Evaluator 3 · Eval2", 3, "Evaluates Speaker 3"],
	[
		"General Evaluator · Gil",
		1,
		"Calls for the Timer's report · calls for votes for Best Evaluator",
	],
	["General Evaluator · Gil", 2, "Evaluates the evaluators"],
	[
		"General Evaluator · Gil",
		3,
		"Calls for the Timer, Grammarian & Ah-Counter to report",
	],
	[
		"General Evaluator · Gil",
		2,
		"Overall meeting evaluation · returns control to the Toastmaster",
	],
	[
		"Toastmaster of the Day · Tia",
		2,
		"Awards · Best Table Topics, Best Evaluator & Best Speaker · hands over to the President",
	],
	["President", 2, "Club business · announcements"],
	[
		"President",
		2,
		"Guest Comments · invites our guests to share their thoughts",
	],
	["President", 1, "Adjourns"],
];

describe("expandRunSheet: open speech slot", () => {
	it("omits the speech, its preamble and its linked evaluation, and the clock drops by exactly their minutes", () => {
		// protects=an open speaker slot reserving its booked minutes plus the
		// paired evaluation's; fails_when=any of the three rows survives, or the
		// total moves by anything but speech+evaluation minutes;
		// no_claim=the template path (parity test below) or flex.
		const booked = code(club());
		const rows = code(club(["Ann", null, "Cy"]));
		expect(speechRows(rows)).toHaveLength(2);
		expect(evalRows(rows)).toHaveLength(2);
		expect(handoffs(rows)).toHaveLength(handoffs(booked).length - 1);
		expect(rows.some((r) => r.who.includes("— open —"))).toBe(false);
		const bookedSpeech = speechRows(booked).find((r) => r.slotId === "sp1");
		const bookedEval = evalRows(booked).find((r) => r.slotId === "ev1");
		expect(bookedSpeech?.minutes).toBeGreaterThan(0);
		expect(bookedEval?.minutes).toBeGreaterThan(0);
		expect(sum(booked) - sum(rows)).toBe(
			(bookedSpeech?.minutes ?? 0) + (bookedEval?.minutes ?? 0),
		);
	});

	it("renumbers the booked speakers 1, 2 and the evaluators to match", () => {
		// protects=the "Speaker 1, Speaker 2, never Speaker 3" rule and the
		// evaluation naming the right speaking slot; fails_when=numbering runs
		// before the filter; no_claim=zero mode numbering (unchanged by design).
		const rows = code(club(["Ann", null, "Cy"]));
		expect(speechRows(rows).map((r) => r.who)).toEqual([
			"Speaker 1 · Ann",
			"Speaker 2 · Cy",
		]);
		expect(evalRows(rows).map((r) => [r.who, r.detail])).toEqual([
			["Evaluator 1 · Eval0", "Evaluates Speaker 1"],
			["Evaluator 2 · Eval2", "Evaluates Speaker 2"],
		]);
	});

	it("keeps an unlinked evaluator when a speech slot is open", () => {
		// protects=an evaluator with evaluatesSlotId=null being unaffected;
		// fails_when=the orphan rule drops every evaluator when any speaker is
		// open; no_claim=who that evaluator evaluates.
		const slots = club(["Ann", null], [evaluator(9, "Free", null)]);
		const evs = evalRows(code(slots));
		expect(evs.map((r) => r.slotId)).toEqual(["ev0", "ev9"]);
	});

	it("does not throw and emits nothing speech-shaped when every speech slot is open", () => {
		// protects=criterion 6; fails_when=an empty speaker set throws or leaves
		// a paired evaluation; no_claim=what else the agenda prints.
		const rows = code(club([null, null, null]));
		expect(speechRows(rows)).toHaveLength(0);
		expect(evalRows(rows)).toHaveLength(0);
		expect(rows.some((r) => r.who.includes("Speaker"))).toBe(false);
		expect(() => template(club([null, null, null]))).not.toThrow();
		expect(speechRows(template(club([null, null, null])))).toHaveLength(0);
		expect(evalRows(template(club([null, null, null])))).toHaveLength(0);
	});

	it("zero mode keeps the rows at 0 minutes, flagged, with their open label and number", () => {
		// protects=the editor's block staying editable and numbered as shown;
		// fails_when=zero mode drops the row, keeps its minutes/marks, or flags a
		// booked row; no_claim=how the editor renders the flag.
		const rows = code(club(["Ann", null, "Cy"]), "zero");
		const open = rows.find((r) => r.slotId === "sp1");
		expect(open).toMatchObject({
			who: "Speaker 2 · — open —",
			minutes: 0,
			marks: null,
			openSpeech: true,
		});
		const orphan = rows.find((r) => r.slotId === "ev1");
		expect(orphan).toMatchObject({ minutes: 0, openSpeech: true });
		expect(rows.find((r) => r.slotId === "sp0")?.openSpeech).toBeUndefined();
		expect(rows.find((r) => r.slotId === "sp0")?.minutes).toBe(7);
		// Same clock as omit: 0-minute rows add nothing.
		expect(sum(rows)).toBe(sum(code(club(["Ann", null, "Cy"]))));
	});

	it("prints a booked-only meeting exactly as origin/main did", () => {
		// protects=criterion 10 against a golden captured from origin/main's
		// builders (not against our own zero mode); fails_when=a booked-only
		// meeting's who, minutes or detail move on either path, or an openSpeech
		// flag appears; no_claim=meetings with an open slot, or fields beyond
		// who/minutes/detail.
		const slots = club();
		const pick = (rows: AgendaRow[]) =>
			rows.map((r) => [r.who, r.minutes, r.detail]);
		expect(pick(code(slots))).toEqual(BOOKED_GOLDEN);
		expect(pick(template(slots))).toEqual(BOOKED_GOLDEN);
		expect(code(slots).some((r) => "openSpeech" in r)).toBe(false);
		expect(template(slots).some((r) => "openSpeech" in r)).toBe(false);
	});
});

describe("buildTemplateRows: open speech slot", () => {
	it("prints the same speech, preamble and evaluation rows as the code path", () => {
		// protects=criterion 2 parity; fails_when=the two builders disagree about
		// which rows an open slot leaves; no_claim=section bands (filtered out).
		const slots = club(["Ann", null, "Cy"]);
		const pick = (rows: AgendaRow[]) =>
			rows.map((r) => [r.who, r.minutes, r.detail]);
		expect(pick(template(slots))).toEqual(pick(code(slots)));
		expect(speechRows(template(slots))).toHaveLength(2);
		expect(handoffs(template(slots)).length).toBe(handoffs(code(slots)).length);
	});

	it("emits no rows for a contest iteration bound to an open contestant", () => {
		// protects=criterion 3; fails_when=the block still emits per open slot;
		// no_claim=the rows of the other iterations, beyond the count.
		const four = contestFixture(4);
		const open = four.slots.map((s) =>
			s.isSpeakerRole && s.slotIndex === 1 ? { ...s, assigneeName: null } : s,
		);
		const three = contestFixture(3);
		const rows = buildTemplateRows(four.beats, four.roles, open);
		expect(rows).toHaveLength(
			buildTemplateRows(three.beats, three.roles, three.slots).length,
		);
		expect(rows.length).toBeLessThan(
			buildTemplateRows(four.beats, four.roles, four.slots).length,
		);
		const zeroed = buildTemplateRows(four.beats, four.roles, open, "zero");
		expect(zeroed).toHaveLength(
			buildTemplateRows(four.beats, four.roles, four.slots).length,
		);
		expect(zeroed.filter((r) => r.openSpeech).length).toBeGreaterThan(0);
		expect(
			zeroed.filter((r) => r.openSpeech).every((r) => r.minutes === 0),
		).toBe(true);
	});

	describe("evaluator beats", () => {
		const beat = (
			over: Partial<TemplateBeatRow> & { id: string; sortOrder: number },
		): TemplateBeatRow => ({
			kind: "role",
			label: "Evaluation",
			detail: null,
			minutes: 3,
			roleKey: "evaluator",
			repeatsRoleKey: null,
			flex: false,
			handoff: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
			clubGoverned: false,
			...over,
		});
		const roles = ROLES.filter((r) => r.isSpeakerRole);
		const slots: AgendaSlot[] = [
			speaker(0, "Ann"),
			speaker(1, null),
			evaluator(0, "EvalA", "sp0"),
			evaluator(1, "EvalB", "sp1"),
		];

		it("emits nothing for an orphaned evaluator's iteration of a repeat block", () => {
			// protects=7a (repeat form); fails_when=the orphan's iteration stays;
			// no_claim=the speech block.
			const rows = buildTemplateRows(
				[
					beat({
						id: "e",
						sortOrder: 0,
						repeatsRoleKey: "evaluator",
					}),
					beat({
						id: "m",
						sortOrder: 1,
						kind: "event",
						roleKey: null,
						label: "Minute of silence",
						repeatsRoleKey: "evaluator",
					}),
				],
				roles,
				slots,
			);
			expect(rows.map((r) => r.slotId)).toEqual(["ev0", null]);
		});

		it("binds a non-repeating evaluator beat to the linked evaluators only, and drops it when none remain", () => {
			// protects=7a (single-beat form); fails_when=the orphan stays bound,
			// or the row survives with no evaluator; no_claim=zero mode (below).
			const one = buildTemplateRows(
				[beat({ id: "e", sortOrder: 0 })],
				roles,
				slots,
			);
			expect(one).toHaveLength(1);
			expect(one[0]?.holder).toBe("EvalA");
			const none = buildTemplateRows([beat({ id: "e", sortOrder: 0 })], roles, [
				speaker(0, null),
				evaluator(0, "EvalA", "sp0"),
			]);
			expect(none).toHaveLength(0);
			const zero = buildTemplateRows(
				[beat({ id: "e", sortOrder: 0 })],
				roles,
				[speaker(0, null), evaluator(0, "EvalA", "sp0")],
				"zero",
			);
			expect(zero).toHaveLength(1);
			expect(zero[0]).toMatchObject({ minutes: 0, openSpeech: true });
		});

		it("carries provenance for the surviving iterations only", () => {
			// protects=sourced iteration indexes matching the rows that remain;
			// fails_when=iteration numbers keep the dropped slot's index;
			// no_claim=the rows themselves (the repeat-block test above) or zero mode.
			const sourced = buildTemplateRowsWithSource(
				[beat({ id: "e", sortOrder: 0, repeatsRoleKey: "evaluator" })],
				roles,
				slots,
			);
			expect(sourced.map((e) => [e.iteration, e.iterationCount])).toEqual([
				[0, 1],
			]);
		});
	});
});

describe("7-minute fallback", () => {
	it("books a speaker with no stored window at the 7-minute fallback in omit mode", () => {
		// protects=speechBookedMinutes' fallback surviving the omit filter;
		// fails_when=a booked speaker with no min/max stops reserving 7 minutes;
		// no_claim=an open slot (reserves 0, tested above).
		const rows = code([
			slot("sp0", "speaker", "Speaker", "Ann", {
				isSpeakerRole: true,
				category: "speaker",
			}),
		]);
		const sp = rows.find((r) => r.slotId === "sp0");
		expect(sp?.minutes).toBe(7);
		expect(sp?.marks).toBeNull();
	});
});

describe("tokens resolve against the full slot set", () => {
	it("keeps {awards} listing Best Speaker on both paths when every speaker is open", () => {
		// protects=a token naming what the club RUNS, not who is booked (the code
		// path resolves against all slots); fails_when=the template path resolves
		// tokens against the filtered set and drops Best Speaker;
		// no_claim=row emission (filtered, tested elsewhere).
		const slots = club([null, null, null]);
		const awards = (rows: AgendaRow[]) =>
			rows.find((r) => r.detail.startsWith("Awards"))?.detail;
		expect(awards(code(slots))).toContain("Best Speaker");
		expect(awards(template(slots))).toContain("Best Speaker");
		expect(awards(template(slots))).toBe(awards(code(slots)));
	});
});

describe("a non-repeating contest beat with every contestant open", () => {
	const roles: TemplateRoleRow[] = [
		{ key: "contestant", name: "Contestant", isSpeakerRole: true },
		{ key: "chair", name: "Contest Chair", isSpeakerRole: false },
	];
	const b = (
		over: Partial<TemplateBeatRow> & { id: string; sortOrder: number },
	): TemplateBeatRow => ({
		kind: "role",
		label: "x",
		detail: null,
		minutes: 7,
		roleKey: "contestant",
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		clubGoverned: false,
		...over,
	});
	const beats = [
		b({ id: "open", sortOrder: 0, label: "Opening", roleKey: "chair" }),
		b({ id: "speeches", sortOrder: 1, label: "Contest speeches" }),
		b({
			id: "preamble",
			sortOrder: 2,
			label: "Chair introduces",
			roleKey: "chair",
			minutes: 0,
			handoff: true,
			repeatsRoleKey: "contestant",
		}),
		b({
			id: "speech",
			sortOrder: 3,
			label: "Contest speech",
			repeatsRoleKey: "contestant",
		}),
		b({
			id: "silence",
			sortOrder: 4,
			kind: "event",
			roleKey: null,
			label: "Silence",
			minutes: 1,
			repeatsRoleKey: "contestant",
		}),
	];
	const contestants = (names: (string | null)[]) =>
		names.map((n, i) =>
			slot(`c${i}`, "contestant", "Contestant", n, {
				isSpeakerRole: true,
				category: "speaker",
				slotIndex: i,
				slotsUnordered: true,
			}),
		);
	const chair = slot("ch", "chair", "Contest Chair", "Chi");

	it("omit: emits no contest row, no preamble row and no per-iteration row", () => {
		// protects=criterion 6 on the template path (maintainer decision on
		// PR #1482): all-open means no contest time; fails_when=the "Contest
		// speeches" row, a preamble (hand-off) row or a silence row survives, or
		// the chair's own beat is lost; no_claim=a partly-open contest (criterion 3).
		const rows = buildTemplateRows(beats, roles, [
			chair,
			...contestants([null, null]),
		]);
		expect(rows.map((r) => r.roleLabel ?? r.who)).toEqual(["Opening"]);
		expect(rows.some((r) => r.handoff)).toBe(false);
		expect(rows.some((r) => r.who.includes(OPEN_LABEL))).toBe(false);
	});

	it("zero: keeps every row at 0 minutes for the contestant rows, flagged", () => {
		// protects=the editor keeping the all-open contest editable;
		// fails_when=zero mode omits, keeps minutes, or leaves marks;
		// no_claim=how the editor labels it.
		const rows = buildTemplateRows(
			beats,
			roles,
			[chair, ...contestants([null, null])],
			"zero",
		);
		const speeches = rows.filter(
			(r) => r.roleLabel === "Contest speeches" || r.openSpeech,
		);
		expect(speeches.length).toBeGreaterThanOrEqual(1);
		expect(rows.find((r) => r.roleLabel === "Contest speeches")).toMatchObject({
			minutes: 0,
			marks: null,
			openSpeech: true,
		});
		expect(speeches.every((r) => r.minutes === 0)).toBe(true);
	});

	it("still emits the contest row, naming the entrants, when one contestant is booked", () => {
		// protects=the omit not firing on a partly-held beat;
		// fails_when=a single booked entrant loses the roster row;
		// no_claim=the minutes of the open iteration.
		const rows = buildTemplateRows(beats, roles, [
			chair,
			...contestants(["Faisal", null]),
		]);
		const roster = rows.find((r) => r.roleLabel === "Contest speeches");
		expect(roster?.holders).toEqual(["Faisal"]);
	});
});

describe("zero mode, non-repeating evaluator beat with mixed holders", () => {
	it("keeps every holder bound and zeroes nothing while one is linked", () => {
		// protects=the maintainer's "the same rows are still emitted" for the
		// editor; fails_when=zero mode narrows the bound set to the linked
		// holders, or zeroes a beat that still has a linked holder;
		// no_claim=omit mode (binds linked only, tested above).
		const eb: TemplateBeatRow = {
			id: "e",
			sortOrder: 0,
			kind: "role",
			label: "Evaluation",
			detail: null,
			minutes: 3,
			roleKey: "evaluator",
			repeatsRoleKey: null,
			flex: false,
			handoff: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
			clubGoverned: false,
		};
		const slots: AgendaSlot[] = [
			speaker(0, "Ann"),
			speaker(1, null),
			evaluator(0, "EvalA", "sp0"),
			evaluator(1, "EvalB", "sp1"),
		];
		const roles = ROLES.filter((r) => r.isSpeakerRole);
		const rows = buildTemplateRows([eb], roles, slots, "zero");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.holders).toEqual(["EvalA", "EvalB"]);
		expect(rows[0]?.minutes).toBe(3);
		expect(rows[0]?.openSpeech).toBeUndefined();
	});
});

describe("applyFlex absorbs the freed minutes", () => {
	const fixedMinutes = (rows: AgendaRow[]) =>
		sum(rows.filter((r) => r.flex !== true));
	const tt = (rows: AgendaRow[]) =>
		rows.filter((r) => r.flex === true).reduce((n, r) => n + r.minutes, 0);

	it("grows Table Topics by exactly the freed minutes under the cap, and ends on time", () => {
		// protects=criterion 7 (under the cap); fails_when=freed minutes vanish
		// or the end time moves; no_claim=the cap.
		const booked = code(club());
		const target = fixedMinutes(booked) + 10;
		const before = applyFlex(booked, target);
		const open = code(club(["Ann", null, "Cy"]));
		const after = applyFlex(open, target);
		const freed = fixedMinutes(booked) - fixedMinutes(open);
		expect(freed).toBeGreaterThan(0);
		expect(tt(before.rows)).toBe(10);
		expect(tt(after.rows)).toBe(10 + freed);
		expect(after.projectedMinutes).toBe(target);
		expect(after.deltaMinutes).toBe(0);
	});

	it("caps at TABLE_TOPICS_MAX and reports the shortfall through deltaMinutes", () => {
		// protects=criterion 7 (past the cap); fails_when=the cap is lifted or the
		// shortfall is hidden; no_claim=banner wording.
		const booked = code(club());
		const target = fixedMinutes(booked) + 22;
		const open = code(club(["Ann", null, "Cy"]));
		const freed = fixedMinutes(booked) - fixedMinutes(open);
		const after = applyFlex(open, target);
		expect(tt(after.rows)).toBe(TABLE_TOPICS_MAX);
		expect(after.deltaMinutes).toBe(-(22 + freed - TABLE_TOPICS_MAX));
	});
});

describe("connector clock", () => {
	it("totals the same minutes as the print pipeline when a contestant slot is open", () => {
		// protects=criterion 9: `get_agenda`'s clock and print's agree;
		// fails_when=the connector times an open slot print omits;
		// no_claim=per-row start strings.
		const f = contestFixture(4);
		const slots = f.slots.map((s) =>
			s.isSpeakerRole && s.slotIndex === 1 ? { ...s, assigneeName: null } : s,
		);
		const printed = applyFlex(
			buildTemplateRows(f.beats, f.roles, slots),
			f.length,
		);
		const sheet = agendaRunSheet({
			idSource: "stored",
			rows: f.beats,
			roles: f.roles,
			slots,
			scheduledAt: f.startsAt.toISOString(),
			timeZone: f.tz,
			lengthMinutes: f.length,
			tableTopicsLimits: null,
		});
		expect(sheet.totalMinutes).toBe(printed.projectedMinutes);
		expect(sheet.totalMinutes).toBeLessThan(
			applyFlex(buildTemplateRows(f.beats, f.roles, f.slots), f.length)
				.projectedMinutes,
		);
	});

	it("totals the same minutes as print for the code run of show with Speaker 2 open and a linked evaluator", () => {
		// protects=criterion 9 on criterion 1's meeting: the connector's clock
		// over the materialised run of show equals the print clock over the code
		// run of show, and both equal a hand-computed golden; fails_when=either
		// side times Speaker 2 or its evaluation, or the two disagree;
		// no_claim=per-row start strings.
		const slots = club(["Ann", null, "Cy"]);
		const length = 120;
		const printed = applyFlex(code(slots), length);
		const sheet = agendaRunSheet({
			idSource: "stored",
			rows: seeds(),
			roles: ROLES,
			slots,
			scheduledAt: "2026-11-05T19:00:00.000Z",
			timeZone: "UTC",
			lengthMinutes: length,
			tableTopicsLimits: null,
		});
		expect(sheet.totalMinutes).toBe(printed.projectedMinutes);
		// 66 booked minutes - Speaker 2's 7 - its evaluation's 3 = 56, with Table
		// Topics (10 booked) flexed to the 25 cap: 56 - 10 + 25.
		expect(sheet.totalMinutes).toBe(71);
	});
});
