import { describe, expect, it } from "vitest";
import type { AgendaRow, AgendaSlot, Beat } from "./agenda-runsheet";
import {
	AWARDS_TOKEN,
	applyFlex,
	beatDuration,
	beatTiming,
	buildLegend,
	buildReportingLegend,
	buildRunOfShow,
	EVALUATION_MARKS,
	expandRunSheet,
	FLEX_TOLERANCE_MINUTES,
	flexBannerMessage,
	formatBeatMinutes,
	functionarySlots,
	hasAnyFunctionaryRole,
	hasAnyReportingFunctionaryRole,
	OPEN_LABEL,
	ROLES_TOKEN,
	RUN_OF_SHOW,
	reportingFunctionarySlots,
	TABLE_TOPICS_MARKS,
	TABLE_TOPICS_MAX,
	TABLE_TOPICS_MIN,
} from "./agenda-runsheet";
import { buildTimeline } from "./agenda-timing";

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s",
		roleName: "Timer",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...over,
	};
}

/**
 * A club running all six roles the segment-ownership and hand-off beats care
 * about: the three segment leaders, a speaker, an evaluator, and the Timer
 * whose absence drives the vote beats' fallback. Every slot defaults to
 * `slotIndex: 0`, so the order of this array carries no meaning — callers
 * `.filter()` a role out to build the "club that does not run X" cases.
 */
const sixRoleClub = (): AgendaSlot[] => [
	slot({
		id: "tm",
		roleKey: "toastmaster_of_the_day",
		roleName: "Toastmaster of the Day",
		category: "leadership",
		assigneeName: "Faisal",
	}),
	slot({
		id: "ttm",
		roleKey: "table_topics_master",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "Rasheed",
	}),
	slot({
		id: "sp",
		roleKey: "speaker",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "Jagpal",
	}),
	slot({
		id: "ev",
		roleKey: "evaluator",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Sudheer",
	}),
	slot({
		id: "ge",
		roleKey: "general_evaluator",
		roleName: "General Evaluator",
		category: "leadership",
		assigneeName: "Riyaz",
	}),
	slot({
		id: "ti",
		roleKey: "timer",
		roleName: "Timer",
		category: "functionary",
		assigneeName: "Muhammad",
	}),
];

/** The functionary-intro beat's TEMPLATE detail — tokens unresolved. Named once
 *  because five assertions pin it, and #508 appended the Word-of-the-Day cue to
 *  it: five copies would mean five places to miss on the next wording change. */
const FUNCTIONARY_INTRO_DETAIL = `Introduces the ${ROLES_TOKEN}; each explains their role · the {role:grammarian} gives the Word of the Day`;

describe("buildRunOfShow", () => {
	it("returns 22 ordered beats for the corrected default (non-MCF) variant", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		// 21 since #508 added the evaluation-timing cue; 22 since #442 split the
		// President's closing into announcements / guest comments / adjourn.
		expect(beats).toHaveLength(22);
	});

	// Was "every beat has a positive duration". The 0-minute hand-off beats
	// (#363) contradict that by design — a transition costs the clock nothing —
	// so the invariant is now the tighter biconditional: zero minutes iff
	// hand-off. Anything else with no duration is still a bug.
	it("every beat has a non-negative duration, and only hand-offs are zero", () => {
		for (const flag of [true, false]) {
			for (const beat of buildRunOfShow({ geIntroducesFunctionaries: flag })) {
				expect(beat.minutes).toBeGreaterThanOrEqual(0);
				if (beat.minutes === 0) expect(beat.handoff).toBe(true);
				if (beat.handoff) expect(beat.minutes).toBe(0);
			}
		}
	});

	it("role beats reference the club's standard role keys", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		const roleKeys = beats
			.filter((b) => b.kind === "role")
			.map((b) => (b as { roleKey: string }).roleKey);
		expect(roleKeys).toContain("toastmaster_of_the_day");
		expect(roleKeys).toContain("speaker");
		expect(roleKeys).toContain("evaluator");
		expect(roleKeys).toContain("table_topics_master");
		expect(roleKeys).toContain("general_evaluator");
	});

	it("the functionary intro is owned by the Toastmaster of the Day by default", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		const functionaryIntro = beats[3];
		expect(functionaryIntro.kind).toBe("role");
		expect((functionaryIntro as { roleKey: string }).roleKey).toBe(
			"toastmaster_of_the_day",
		);
		// The detail names the club's own functionaries at expansion time (#367),
		// so the beat carries the token rather than a fixed "the functionaries".
		expect(functionaryIntro.detail).toBe(FUNCTIONARY_INTRO_DETAIL);
	});

	it("the functionary intro is owned by the General Evaluator under MCF's variant", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: true });
		// One index later than the default variant: the opening GE introduction
		// (#363) precedes it here.
		const functionaryIntroBeat = beats[4];
		expect(functionaryIntroBeat.kind).toBe("role");
		expect((functionaryIntroBeat as { roleKey: string }).roleKey).toBe(
			"general_evaluator",
		);
		expect(functionaryIntroBeat.detail).toBe(FUNCTIONARY_INTRO_DETAIL);
	});

	it("gates each vote beat on the segment it belongs to", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		// Matched on the segment the vote is FOR, not the whole detail: this test is
		// about the gate, and the rest of the copy carries a `{role:timer}` token
		// since #445, which would make the lookup a copy assertion in disguise.
		const gateOf = (segment: string) =>
			beats
				.find((b) => b.detail.endsWith(`opens voting for ${segment}`))
				?.requiresAnyOf?.map((r) => r.roleKey);
		expect(gateOf("Best Speaker")).toEqual(["speaker"]);
		expect(gateOf("Best Table Topics")).toEqual(["table_topics_master"]);
		expect(gateOf("Best Evaluator")).toEqual(["evaluator"]);
	});

	it("the MCF variant differs from the default ONLY in the functionary intro's owner and the opening GE introduction that precedes it", () => {
		const withoutGe = buildRunOfShow({ geIntroducesFunctionaries: false });
		const withGe = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(withGe).toHaveLength(withoutGe.length + 1);
		// The extra beat comes FIRST now (#363): the Toastmaster introduces the GE,
		// and the beat after it is the functionary intro the swap moved to them.
		expect(withGe[3]).toMatchObject({
			roleKey: "toastmaster_of_the_day",
			detail:
				"Introduces the {role:general_evaluator}{names:general_evaluator}",
			handoff: true,
		});
		expect(withGe[4]).toMatchObject({
			roleKey: "general_evaluator",
			detail: FUNCTIONARY_INTRO_DETAIL,
		});
		// Every other beat is the default template's, in the default order.
		expect(withGe.filter((_, i) => i !== 3 && i !== 4)).toEqual(
			withoutGe.filter((_, i) => i !== 3),
		);
	});

	// Was two tests: one pinning the MCF-only handback at index 4, and one
	// asserting the default variant had no such beat. #363 makes the speakers
	// hand-off universal, so the second claim is now false — its question ("does
	// this variant carry it?") is answered here for BOTH variants instead.
	it("the speakers hand-off is universal, in a row of its own directly before the prepared speeches", () => {
		for (const geIntroducesFunctionaries of [false, true]) {
			const beats = buildRunOfShow({ geIntroducesFunctionaries });
			// Template detail — `{names:speaker}` is resolved by `expandRunSheet`,
			// not by `buildRunOfShow` (#585).
			const SPEAKERS_HANDOFF = "Introduces the speakers";
			const i = beats.findIndex((b) => b.detail === SPEAKERS_HANDOFF);
			expect(beats.filter((b) => b.detail === SPEAKERS_HANDOFF)).toHaveLength(
				1,
			);
			expect(beats[i]).toMatchObject({
				kind: "role",
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				role: "plain",
				detail: SPEAKERS_HANDOFF,
				handoff: true,
				minutes: 0,
			});
			// Gated on the speakers it promises, not on the functionaries whose intro
			// put the General Evaluator in front of them in MCF's variant.
			expect(beats[i].requiresAnyOf?.map((r) => r.roleKey)).toEqual([
				"speaker",
			]);
			expect(beats[i].requiresGroup).toBeUndefined();
			// Directly after the functionary intro and directly before the speeches.
			expect(beats[i - 1].detail).toBe(FUNCTIONARY_INTRO_DETAIL);
			expect(beats[i + 1]).toMatchObject({ detail: "Prepared speech" });
		}
	});

	it("the GE closing sequence is identical across both variants", () => {
		const withoutGe = buildRunOfShow({ geIntroducesFunctionaries: false });
		const withGe = buildRunOfShow({ geIntroducesFunctionaries: true });
		// The MCF variant carries one extra beat before them (the opening GE
		// introduction), so the shared sequence sits one index later there.
		const closing = [
			"Evaluates the evaluators",
			// Template detail — `buildRunOfShow` returns beats with tokens
			// unresolved; `expandRunSheet` is what turns `{roles}` into names.
			"Calls for the {roles} to report",
			"Overall meeting evaluation · returns control to the Toastmaster",
		];
		for (const detail of closing) {
			const i = withoutGe.findIndex((b) => b.detail === detail);
			expect(i).toBeGreaterThan(-1);
			expect(withGe[i + 1]).toEqual(withoutGe[i]);
		}
	});

	// Guest comments used to be a clause inside the President's closing beat, kept
	// there only because the dedicated beat (#352) was deferred and dropping it
	// would have removed guest comments from every club's agenda with nothing
	// replacing them. This IS the replacement, so the clause goes: two prompts to
	// invite the same guests, one of them with no time booked, is worse than the
	// single row the Toastmaster can point at.
	it("invites guest comments once — its own beat, after the awards (#352)", () => {
		for (const geIntroducesFunctionaries of [false, true]) {
			const beats = buildRunOfShow({ geIntroducesFunctionaries });
			const guests = beats[beats.length - 2];
			expect(guests).toMatchObject({
				kind: "event",
				who: "President",
				detail: "Guest Comments · invites our guests to share their thoughts",
			});
			// Its own minutes, so the timeline accounts for time the meeting was
			// already spending off-book.
			expect(guests.minutes).toBeGreaterThan(0);
			// Exactly one beat asks for guest comments.
			expect(
				beats.filter(
					(b) => /guest/i.test(b.detail) && !/welcome/i.test(b.detail),
				),
			).toHaveLength(1);
		}
	});

	/**
	 * The closing ORDER is the whole of #442, and `agenda-parity.test.ts` cannot
	 * see it: that suite compares the run sheet against the deck by shared
	 * section identity, and `SECTION_BY_SLIDE` maps the `reminders` slide to
	 * `null` — announcements are excluded from the comparison on the deck side
	 * entirely. So parity stays green whichever order announcements sit in, on
	 * BOTH surfaces. This is the golden assertion that actually pins it, and
	 * `agenda-slides.test.ts` carries the matching one for the deck.
	 *
	 * Asserted as a contiguous slice rather than three separate index lookups so
	 * that inserting a beat between any two of them fails here.
	 */
	it("closes announcements → guest comments → adjourn (#442)", () => {
		for (const geIntroducesFunctionaries of [false, true]) {
			const beats = buildRunOfShow({ geIntroducesFunctionaries });
			expect(beats.slice(-4).map((b) => b.detail)).toEqual([
				`Awards · ${AWARDS_TOKEN} · hands over to the President`,
				"Club business · announcements",
				"Guest Comments · invites our guests to share their thoughts",
				"Adjourns",
			]);
			// The club's own business finishes before the floor goes to visitors,
			// and the meeting ends on the guests rather than on ourselves.
			const detail = beats.map((b) => b.detail);
			expect(detail.indexOf("Club business · announcements")).toBeLessThan(
				detail.findIndex((d) => d.startsWith("Guest Comments")),
			);
			expect(
				detail.findIndex((d) => d.startsWith("Guest Comments")),
			).toBeLessThan(detail.indexOf("Adjourns"));
		}
	});

	/**
	 * Splitting the closing must not move the meeting's end time. The old
	 * combined beat was 3 minutes; the split is 2 + 1 with guest comments' 2
	 * unchanged between them.
	 */
	it("#442's split leaves the closing's total minutes unchanged", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		const closing = beats.slice(-3);
		expect(closing.reduce((n, b) => n + b.minutes, 0)).toBe(5);
	});

	it("RUN_OF_SHOW is the corrected default variant, kept exported for existing callers", () => {
		expect(RUN_OF_SHOW).toEqual(
			buildRunOfShow({ geIntroducesFunctionaries: false }),
		);
	});
});

describe("beat durations quoted by the deck (#356)", () => {
	it("formats a beat's budget as slide copy, singular at one minute", () => {
		expect(formatBeatMinutes(1)).toBe("1 minute");
		expect(formatBeatMinutes(2)).toBe("2 minutes");
		expect(formatBeatMinutes(3)).toBe("3 minutes");
	});

	it("resolves every quoted beat, identically for both club variants", () => {
		// Today's numbers, stated once. They are the run sheet's — the deck no
		// longer keeps a second copy that can disagree, which is the whole point:
		// changing a beat's `minutes` moves the projected slide with it.
		for (const geIntroducesFunctionaries of [false, true]) {
			const template = buildRunOfShow({ geIntroducesFunctionaries });
			expect(beatDuration(template, "evaluation")).toBe("3 minutes");
			expect(beatDuration(template, "evaluatorEvaluation")).toBe("2 minutes");
			expect(beatDuration(template, "generalEvaluation")).toBe("2 minutes");
		}
	});

	it("reads the beat rather than a copy of its number", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: false });
		const retimed = template.map((b) =>
			b.id === "evaluation" ? { ...b, minutes: 5 } : b,
		);
		expect(beatDuration(retimed, "evaluation")).toBe("5 minutes");
	});

	it("throws rather than guessing when the template has no such beat", () => {
		expect(() => beatDuration([], "evaluation")).toThrow(/evaluation/);
	});
});

/**
 * `beatTiming` — what a slide says a beat is TIMED against, as opposed to what
 * the clock BOOKS for it (#583).
 *
 * Sits beside the `beatDuration` block above because the two are the same seam
 * seen from two sides, and the interesting cases are the ones no shipped beat
 * reaches: every standard template has `EVALUATION_MARKS.green` (2) below the
 * beat's `minutes` (3), so the fallbacks below are dead to the rest of the
 * suite and could be deleted or inverted with everything green.
 */
describe("beatTiming (#583)", () => {
	const template = buildRunOfShow({ geIntroducesFunctionaries: false });
	const retimed = (minutes: number) =>
		template.map((b) => (b.id === "evaluation" ? { ...b, minutes } : b));

	it("states the window a beat carrying marks is signalled against", () => {
		// The number the Timer's card shows (green 2:00) through the number the
		// printed clock reserves (3), which is the invariant #356 defends.
		for (const geIntroducesFunctionaries of [false, true]) {
			expect(
				beatTiming(buildRunOfShow({ geIntroducesFunctionaries }), "evaluation"),
			).toBe("2–3 minutes");
		}
	});

	it("states the plain budget for a beat with no marks", () => {
		// Nothing signals against these, so a range would invent a window.
		expect(beatTiming(template, "evaluatorEvaluation")).toBe("2 minutes");
		expect(beatTiming(template, "generalEvaluation")).toBe("2 minutes");
	});

	it("moves with the beat, so a retimed beat retimes the slide", () => {
		expect(beatTiming(retimed(5), "evaluation")).toBe("2–5 minutes");
	});

	it("falls back to the budget rather than projecting an inverted or empty range", () => {
		// green === minutes: the range would read "2–2 minutes".
		expect(beatTiming(retimed(2), "evaluation")).toBe("2 minutes");
		// green > minutes: the range would read backwards. Also the singular.
		expect(beatTiming(retimed(1), "evaluation")).toBe("1 minute");
	});

	it("throws rather than guessing when the template has no such beat", () => {
		expect(() => beatTiming([], "evaluation")).toThrow(/evaluation/);
	});
});

describe("buildLegend", () => {
	it("lists functionary roles with their assignees, in input order", () => {
		const slots = [
			slot({ id: "t", roleName: "Timer", assigneeName: "Alice" }),
			slot({ id: "g", roleName: "Grammarian", assigneeName: "Bob" }),
			slot({
				id: "sp",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: "Cara",
			}),
		];
		expect(buildLegend(slots)).toEqual([
			{ role: "Timer", name: "Alice" },
			{ role: "Grammarian", name: "Bob" },
		]);
	});

	it("shows the open placeholder for an unassigned functionary", () => {
		expect(
			buildLegend([slot({ roleName: "Ah-Counter", assigneeName: null })]),
		).toEqual([{ role: "Ah-Counter", name: "— open —" }]);
	});
});

/**
 * The single definition of "this club's functionaries" (#371). Before it, the
 * legend filtered on `category === "functionary"` while the beat gates and the
 * `{roles}` token resolved against the four standard keys — so a club's own
 * "Joke Master" appeared on the projected slide but not in the printed row, and
 * a club that disabled all four standard functionaries lost both functionary
 * beats from both surfaces while the legend still listed its people.
 *
 * The call: the CATEGORY is the definition. Keys are for identity — they make a
 * beat rename-proof (#368) — not for membership. A club marking a role
 * `category: "functionary"` is the club telling us it is one.
 */
describe("functionarySlots (#371)", () => {
	it("is the category, not the standard key set", () => {
		const jokeMaster = slot({
			id: "jm",
			roleKey: null,
			roleName: "Joke Master",
			category: "functionary",
		});
		const timer = slot({ id: "ti", roleName: "Timer" });
		const tmod = slot({
			id: "tm",
			roleName: "Toastmaster of the Day",
			category: "leadership",
		});
		expect(functionarySlots([tmod, timer, jokeMaster])).toEqual([
			timer,
			jokeMaster,
		]);
	});

	it("is exactly what buildLegend lists, so slide and printed row can't diverge", () => {
		const slots = [
			slot({ id: "ti", roleName: "Timer", assigneeName: "Alice" }),
			slot({
				id: "jm",
				roleKey: null,
				roleName: "Joke Master",
				assigneeName: "Bob",
			}),
			slot({ id: "sp", roleName: "Speaker", category: "speaker" }),
		];
		expect(buildLegend(slots)).toEqual(
			functionarySlots(slots).map((s) => ({
				role: s.roleName,
				name: s.assigneeName ?? "— open —",
			})),
		);
	});
});

/**
 * The functionary-reports gate is "functionaries who REPORT", not
 * "functionaries" (#371). A Vote Counter is a functionary — introduced at the
 * functionary-intro beat, listed in the legend — but tallies votes rather than
 * giving a report, so a Vote-Counter-only club must not get a "Calls for the
 * functionary reports" beat naming only them. Vote Counter is excluded by
 * IDENTITY (its key), which is what keys are for; a club-invented functionary
 * is presumed to report, since we cannot know otherwise and an extra name in a
 * list the GE reads out is a smaller error than silently deleting the beat.
 */
describe("reportingFunctionarySlots (#371)", () => {
	it("drops the Vote Counter and keeps the three that report", () => {
		const timer = slot({ id: "ti", roleName: "Timer" });
		const grammarian = slot({ id: "gr", roleName: "Grammarian" });
		const ahCounter = slot({ id: "ah", roleName: "Ah-Counter" });
		const voteCounter = slot({ id: "vc", roleName: "Vote Counter" });
		expect(
			reportingFunctionarySlots([timer, grammarian, ahCounter, voteCounter]),
		).toEqual([timer, grammarian, ahCounter]);
	});

	it("drops a RENAMED Vote Counter too — identity is the key (#368)", () => {
		expect(
			reportingFunctionarySlots([
				slot({
					id: "vc",
					roleKey: "vote_counter",
					roleName: "Ballot Wrangler",
				}),
			]),
		).toEqual([]);
	});

	it("keeps a club-invented functionary, which is presumed to report", () => {
		const jokeMaster = slot({
			id: "jm",
			roleKey: null,
			roleName: "Joke Master",
		});
		expect(reportingFunctionarySlots([jokeMaster])).toEqual([jokeMaster]);
	});

	it("buildReportingLegend lists exactly those, for the reports slide", () => {
		expect(
			buildReportingLegend([
				slot({ id: "gr", roleName: "Grammarian", assigneeName: "Gina" }),
				slot({ id: "vc", roleName: "Vote Counter", assigneeName: "Omar" }),
			]),
		).toEqual([{ role: "Grammarian", name: "Gina" }]);
	});
});

describe("expandRunSheet", () => {
	it("passes event beats through as label-only rows (no marks)", () => {
		const rows = expandRunSheet([]);
		const callToOrder = rows[0];
		expect(callToOrder.who).toBe("Sergeant-at-Arms");
		expect(callToOrder.marks).toBeNull();
		expect(callToOrder.minutes).toBe(1);
	});

	it("renders ungated event beats unconditionally, even with no slots at all", () => {
		const rows = expandRunSheet([]);
		expect(rows.some((r) => r.who === "Sergeant-at-Arms")).toBe(true);
		// Opening remarks, announcements, guest comments (#352) and the adjourn.
		// Guest comments is unconditional by design: every meeting can have guests,
		// and the spec rules out a per-club toggle. The closing is three rows since
		// #442 split it so the guests speak between the business and the gavel.
		expect(rows.filter((r) => r.who === "President")).toHaveLength(4);
	});

	it("drops the awards beat with no slots — it is gated, not ungated (#372)", () => {
		// The awards beat is the one Toastmaster-owned beat in this group that IS
		// gated: on the scored segments, so a club hands out only the awards it
		// scores.
		const rows = expandRunSheet([]);
		expect(rows.some((r) => r.detail.startsWith("Awards ·"))).toBe(false);
		const scored = expandRunSheet([
			slot({
				id: "sp",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: "S",
			}),
		]);
		expect(
			scored.some(
				(r) =>
					r.detail.startsWith("Awards ·") && r.who === "Toastmaster of the Day",
			),
		).toBe(true);
	});

	it("renders a plain role with its assignee name", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Dana",
			}),
		]);
		expect(rows.some((r) => r.who === "Toastmaster of the Day · Dana")).toBe(
			true,
		);
	});

	it("expands speakers by actual slots, numbering when >1, with marks from min/max and duration from max", () => {
		const rows = expandRunSheet([
			slot({
				id: "s1",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
				assigneeName: "Rehanna",
				speechTitle: "Chai",
				projectLevel: "L2",
				minMinutes: 5,
				maxMinutes: 7,
			}),
			slot({
				id: "s2",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 1,
				assigneeName: "Sudheer",
				speechTitle: "Clubs",
				projectLevel: "L4",
				minMinutes: 5,
				maxMinutes: 7,
			}),
		]);
		const sp1 = rows.find((r) => r.who.startsWith("Speaker 1"));
		expect(sp1?.who).toBe("Speaker 1 · Rehanna");
		expect(sp1?.detail).toBe('"Chai" · L2');
		expect(sp1?.minutes).toBe(7);
		expect(sp1?.marks).toEqual({ green: 5, yellow: 6, red: 7 });
		expect(rows.some((r) => r.who === "Speaker 2 · Sudheer")).toBe(true);
	});

	it("uses the open placeholder and fallback duration for an open speaker with no details", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: null,
			}),
		]);
		const sp = rows.find((r) => r.who.startsWith("Speaker"));
		expect(sp?.who).toBe("Speaker · — open —");
		expect(sp?.minutes).toBe(7);
		expect(sp?.marks).toBeNull();
	});

	it("orders evaluators by the speaker they evaluate and labels 'Evaluates X'", () => {
		const slots = [
			slot({
				id: "spA",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
				assigneeName: "A",
			}),
			slot({
				id: "spB",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 1,
				assigneeName: "B",
			}),
			// Evaluator slots given OUT of speaker order; expansion must reorder.
			slot({
				id: "e2",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 0,
				assigneeName: "EvalB",
				evaluatesSlotId: "spB",
				evaluates: { speakerName: "B" },
			}),
			slot({
				id: "e1",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 1,
				assigneeName: "EvalA",
				evaluatesSlotId: "spA",
				evaluates: { speakerName: "A" },
			}),
		];
		const rows = expandRunSheet(slots);
		const evalRows = rows.filter((r) => r.who.startsWith("Evaluator"));
		expect(evalRows[0].who).toBe("Evaluator 1 · EvalA");
		expect(evalRows[0].detail).toBe("Evaluates A");
		expect(evalRows[1].who).toBe("Evaluator 2 · EvalB");
	});

	/**
	 * The three states an evaluator row can be in, pinned together so the middle
	 * one cannot silently collapse into the last (#512).
	 *
	 * Before this, a linked evaluator whose speaker was not yet assigned printed
	 * the same "Evaluates a speaker" as an evaluator with no link at all — so an
	 * agenda printed ahead of the roster told the evaluator nothing, and the two
	 * states were indistinguishable on the page. That ambiguity is what kept the
	 * NULL-column bug invisible.
	 */
	it("names the speaking slot when the speaker is not assigned yet (#512)", () => {
		const slots = [
			slot({
				id: "spA",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
				assigneeName: "Rehanna Khan",
			}),
			// Speaker 2 exists but nobody has claimed it.
			slot({
				id: "spB",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 1,
				assigneeName: null,
			}),
			slot({
				id: "e1",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 0,
				assigneeName: "EvalA",
				evaluatesSlotId: "spA",
				evaluates: { speakerName: "Rehanna Khan" },
			}),
			slot({
				id: "e2",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 1,
				assigneeName: "EvalB",
				evaluatesSlotId: "spB",
				evaluates: { speakerName: null },
			}),
			// No link at all — the pre-#512 shape, and every meeting created before
			// the fix. Must still get the beat's generic wording.
			slot({
				id: "e3",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 2,
				assigneeName: "EvalC",
				evaluatesSlotId: null,
				evaluates: null,
			}),
		];
		const detail = expandRunSheet(slots)
			.filter((r) => r.who.startsWith("Evaluator"))
			.map((r) => r.detail);
		expect(detail).toContain("Evaluates Rehanna Khan");
		expect(detail).toContain("Evaluates Speaker 2");
		expect(detail).toContain("Evaluates a speaker");
		// All three are distinct — the point of the change.
		expect(new Set(detail).size).toBe(3);
	});

	it("does not number a lone speaker — 'Evaluates Speaker', not 'Speaker 1'", () => {
		const slots = [
			slot({
				id: "spOnly",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
				assigneeName: null,
			}),
			slot({
				id: "e1",
				roleName: "Evaluator",
				category: "evaluator",
				slotIndex: 0,
				assigneeName: "EvalA",
				evaluatesSlotId: "spOnly",
				evaluates: { speakerName: null },
			}),
		];
		const [row] = expandRunSheet(slots).filter((r) =>
			r.who.startsWith("Evaluator"),
		);
		expect(row.detail).toBe("Evaluates Speaker");
	});
});

describe("timing marks beyond the speaker (#507)", () => {
	// Speakers got the green/yellow/red trio from their speech's own min/max;
	// every other row printed a bare minute count. Evaluations and Table Topics
	// are timed off the same card, so they need the same three numbers.
	it("gives evaluator rows the evaluation window", () => {
		const rows = expandRunSheet(sixRoleClub());
		const evaluator = rows.find((r) => r.roleKey === "evaluator");
		expect(evaluator).toBeDefined();
		expect(evaluator?.marks).toEqual(EVALUATION_MARKS);
	});

	it("gives the Table Topics segment the per-topic window", () => {
		const rows = expandRunSheet(sixRoleClub());
		const segment = rows.find((r) => r.detail.startsWith("Impromptu topics"));
		expect(segment).toBeDefined();
		expect(segment?.marks).toEqual(TABLE_TOPICS_MARKS);
	});

	// The guard that rules out keying marks off the ROLE. The Table Topics
	// Master owns four beats — two hand-offs, the segment, and the vote — and
	// only the segment is timed. A per-role lookup would stamp 1:00/1:30/2:00
	// onto "Introduces the General Evaluator".
	it("leaves the Table Topics Master's OTHER beats unmarked", () => {
		const rows = expandRunSheet(sixRoleClub());
		const owned = rows.filter((r) => r.roleKey === "table_topics_master");
		expect(owned.length).toBeGreaterThan(1);
		for (const row of owned) {
			if (row.detail.startsWith("Impromptu topics")) continue;
			expect(row.marks).toBeNull();
		}
	});

	it("leaves hand-off and functionary rows unmarked", () => {
		const rows = expandRunSheet(sixRoleClub());
		// EVERY hand-off, not just the first — sixRoleClub emits four, and
		// checking one would miss a change that marked the other three. The
		// `?? null` is gone on purpose: it made the assertion pass vacuously if
		// hand-off rows ever stopped being emitted at all.
		const handoffs = rows.filter((r) => r.handoff);
		expect(handoffs.length).toBeGreaterThan(1);
		for (const row of handoffs) expect(row.marks).toBeNull();
		// A functionary-facing row that actually EXISTS. `roleKey === "timer"`
		// matched nothing — no beat is owned by the Timer, it only appears in
		// `requiresAnyOf`/`fallbacks` — so that assertion could never fail.
		// sixRoleClub runs exactly one reporting functionary (the Timer), so
		// `{roles}` resolves to the bare name (#584).
		const reports = rows.find((r) =>
			r.detail.startsWith("Calls for the Timer to report"),
		);
		expect(reports).toBeDefined();
		expect(reports?.marks).toBeNull();
	});

	it("still reads a speaker's marks off their own speech, not a constant", () => {
		// Regression: the speaker path is per-slot and must not collapse into the
		// shared constants.
		const rows = expandRunSheet([
			...sixRoleClub().filter((s) => s.roleName !== "Speaker"),
			slot({
				id: "sp",
				roleName: "Speaker",
				isSpeakerRole: true,
				assigneeName: "Dana",
				minMinutes: 5,
				maxMinutes: 7,
			}),
		]);
		const speaker = rows.find((r) => r.roleKey === "speaker");
		expect(speaker?.marks).toEqual({ green: 5, yellow: 6, red: 7 });
	});
});

describe("expandRunSheet — role-key matching (#368)", () => {
	it("matches a beat's role via roleKey even when the club renamed the role's display name", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "Chief Evaluator", // renamed via updateClubRole
				roleKey: "general_evaluator", // rename never touches the key
				category: "leadership",
				assigneeName: "Priya",
			}),
		]);
		// The row EXISTING is what proves the key matched — a beat bound by display
		// name would have found nothing here.
		expect(rows.some((r) => r.who === "Chief Evaluator · Priya")).toBe(true);
		// And it is labelled the way the CLUB names it (#445), which is the other
		// half of the #368 promise: binding through a rename was never enough on its
		// own, because the row still printed our canonical name, so a renaming club
		// read one name in the header legend and another on every row that role
		// owned. Same page, same role, two names.
		expect(rows.some((r) => r.who.startsWith("General Evaluator"))).toBe(false);
	});

	it("falls back to matching by name when the slot carries no roleKey", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "General Evaluator",
				roleKey: undefined,
				category: "leadership",
				assigneeName: "Priya",
			}),
		]);
		expect(rows.some((r) => r.who === "General Evaluator · Priya")).toBe(true);
	});

	it("does NOT match by name when the slot carries a different, non-null roleKey", () => {
		// A custom/renamed role that happens to be named "General Evaluator" but
		// is really keyed to something else entirely must not satisfy the GE beats.
		const rows = expandRunSheet([
			slot({
				roleName: "General Evaluator",
				roleKey: "vote_counter",
				category: "leadership",
				assigneeName: "Priya",
			}),
		]);
		expect(rows.some((r) => r.detail === "Evaluates the evaluators")).toBe(
			false,
		);
		expect(
			rows.some(
				(r) =>
					r.detail ===
					"Overall meeting evaluation · returns control to the Toastmaster",
			),
		).toBe(false);
	});
});

describe("expandRunSheet — omission of no-slot beats (#367)", () => {
	it("omits a plain-role beat entirely when its role has no slots this meeting", () => {
		const rows = expandRunSheet([]); // no Toastmaster of the Day slot at all
		expect(rows.some((r) => r.who.startsWith("Toastmaster of the Day"))).toBe(
			false,
		);
	});

	it("still renders an enabled-but-unclaimed role as an open row (sign-up prompt)", () => {
		const rows = expandRunSheet([
			slot({
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: null,
			}),
		]);
		expect(
			rows.some((r) => r.who === "Toastmaster of the Day · — open —"),
		).toBe(true);
	});

	it("omits the GE's evaluator-evaluation and overall-evaluation beats when there's no GE slot", () => {
		const rows = expandRunSheet([]);
		expect(rows.some((r) => r.detail === "Evaluates the evaluators")).toBe(
			false,
		);
		expect(
			rows.some(
				(r) =>
					r.detail ===
					"Overall meeting evaluation · returns control to the Toastmaster",
			),
		).toBe(false);
	});
});

describe("expandRunSheet — vote beats are owned by the segment leader (#363)", () => {
	// "voting for Best" narrows to the three scored-segment votes and keeps the
	// functionary intro out of them: its `{roles}` list can name a Vote Counter,
	// which a looser `/vot/i` would swallow.
	const voteRows = (rows: AgendaRow[]) =>
		rows.filter((r) => /voting for Best/i.test(r.detail));

	it("attributes each vote to the leader running that segment", () => {
		const rows = voteRows(expandRunSheet(sixRoleClub(), RUN_OF_SHOW));
		expect(rows.map((r) => [r.who, r.detail])).toEqual([
			[
				"Toastmaster of the Day · Faisal",
				"Calls for the Timer's report · opens voting for Best Speaker",
			],
			[
				"Table Topics Master · Rasheed",
				"Calls for the Timer's report · opens voting for Best Table Topics",
			],
			[
				"General Evaluator · Riyaz",
				"Calls for the Timer's report · opens voting for Best Evaluator",
			],
		]);
	});

	// #445. The clause names a role OTHER than the row's owner, so it cannot come
	// from the matched slot the way the `who` label does — it reads a
	// `roleNameToken`. Before that, a club that renamed Timer to Timekeeper had a
	// header legend saying "Timekeeper · Riyaz" and three vote rows saying "Calls
	// for the Timer's report", which is the same page contradicting itself.
	it("calls for the report under the club's name for the Timer (#445)", () => {
		const renamed = sixRoleClub().map((s) =>
			s.roleKey === "timer" ? { ...s, roleName: "Timekeeper" } : s,
		);
		const details = voteRows(expandRunSheet(renamed, RUN_OF_SHOW)).map(
			(r) => r.detail,
		);
		expect(details).toEqual([
			"Calls for the Timekeeper's report · opens voting for Best Speaker",
			"Calls for the Timekeeper's report · opens voting for Best Table Topics",
			"Calls for the Timekeeper's report · opens voting for Best Evaluator",
		]);
		// The legend the club reads at the top of the same page. Asserted here rather
		// than trusted, because agreeing with it IS the fix.
		expect(buildLegend(renamed).map((l) => l.role)).toContain("Timekeeper");
		expect(details.join(" ")).not.toContain("Timer's");
	});

	// The speaker and evaluator arms label rows through `numbered(s.roleName, …)`
	// rather than the shared plain arm, so they need their own club. Nothing
	// covered them before: the coverage audit found that reverting BOTH arms to
	// `owner.roleName` left all 2302 tests green, because no fixture anywhere
	// pairs a non-canonical `roleName` with a `roleKey` that still binds.
	it("numbers the speaker and evaluator rows under the club's names (#445)", () => {
		const renamed = [
			...sixRoleClub().map((s) =>
				s.roleKey === "speaker"
					? { ...s, roleName: "Presenter" }
					: s.roleKey === "evaluator"
						? { ...s, roleName: "Reviewer" }
						: s,
			),
			slot({
				id: "sp2",
				roleKey: "speaker",
				roleName: "Presenter",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: "Farhanaaz",
				slotIndex: 9,
			}),
		];
		const rows = expandRunSheet(renamed, RUN_OF_SHOW);
		const who = rows.map((r) => r.who);
		// Two speakers ⇒ `multi` ⇒ the ordinal suffix rides the CLUB's name.
		expect(who).toContain("Presenter 1 · Jagpal");
		expect(who).toContain("Presenter 2 · Farhanaaz");
		expect(who).toContain("Reviewer · Sudheer");
		expect(who.filter((w) => w.startsWith("Speaker"))).toEqual([]);
		expect(who.filter((w) => w.startsWith("Evaluator"))).toEqual([]);
	});

	// The print colour fix depends on a speech row carrying `roleKey: "speaker"`.
	// The print test that looks like it covers that hand-builds its row, so the
	// producer side was unasserted — a speech row emitted with no key would fall
	// back to matching "presenter" against English and silently lose its colour.
	it("stamps the owning role's key on speaker and evaluator rows (#445)", () => {
		const renamed = sixRoleClub().map((s) =>
			s.roleKey === "speaker"
				? { ...s, roleName: "Presenter" }
				: s.roleKey === "evaluator"
					? { ...s, roleName: "Reviewer" }
					: s,
		);
		const rows = expandRunSheet(renamed, RUN_OF_SHOW);
		expect(rows.find((r) => r.who.startsWith("Presenter"))?.roleKey).toBe(
			"speaker",
		);
		expect(rows.find((r) => r.who.startsWith("Reviewer"))?.roleKey).toBe(
			"evaluator",
		);
		// Event beats own no role, so they carry no key and the print layer's name
		// fallback is what colours them. Pin the ROW first: `find(...)?.roleKey ??
		// null` reads `null` whether the row is keyless or absent entirely, so
		// deleting the beat outright would have left this green.
		const soa = rows.find((r) => r.who === "Sergeant-at-Arms");
		expect(soa).toBeDefined();
		expect(soa).not.toHaveProperty("roleKey");
	});

	// A slot with no `roleKey` reaches a beat only by matching its canonical NAME
	// (`matchesRole`), so the row genuinely belongs to that role — the club's data
	// just predates the #368 backfill. The row still gets the BEAT's key, which is
	// what the print layer colours by, so a pre-backfill club is not a grey page.
	it("keys a row whose slot carries no roleKey (#445)", () => {
		const rows = expandRunSheet([
			slot({
				roleKey: undefined,
				roleName: "General Evaluator",
				category: "leadership",
				assigneeName: "Priya",
			}),
		]);
		const row = rows.find((r) => r.who === "General Evaluator · Priya");
		expect(row?.roleKey).toBe("general_evaluator");
	});

	// A club role name is admin-typed free text with no character validation, and
	// `String.replace` reads `$&` / "$`" / `$'` in a REPLACEMENT STRING as
	// back-references. The token resolver passes a function instead, so the name
	// substitutes literally. Without that, this club prints its own copy back into
	// the row. Same guard the `ROLES_TOKEN` site documents.
	it("substitutes a role name containing $-sequences literally (#445)", () => {
		// Sequences kept away from the ends so the expectation stays readable: a name
		// ending in `$'` would legitimately double the possessive into `$''s`.
		const hostile = sixRoleClub().map((s) =>
			s.roleKey === "timer" ? { ...s, roleName: "Timer $& $` $' Squad" } : s,
		);
		expect(voteRows(expandRunSheet(hostile, RUN_OF_SHOW))[0].detail).toBe(
			"Calls for the Timer $& $` $' Squad's report · opens voting for Best Speaker",
		);
	});

	// The bug the single-pass rewrite fixed. Resolving the role name first and the
	// LIST tokens second meant a club role named literally "{awards}" had the
	// awards list spliced into its row: "Calls for the Best Table Topic, Best
	// Evaluator & Best Speaker's report". `role-definitions-logic.ts` validates
	// only non-empty, so an admin can type it. One `String.replace` pass never
	// rescans what it substituted, which is what makes this inert by construction
	// rather than by a blocklist.
	it("does not re-resolve a club role name that is itself a token (#445)", () => {
		for (const hostileName of ["{awards}", "{roles}", "{role:timer}"]) {
			const club = sixRoleClub().map((s) =>
				s.roleKey === "timer" ? { ...s, roleName: hostileName } : s,
			);
			const detail = voteRows(expandRunSheet(club, RUN_OF_SHOW))[0].detail;
			expect(detail).toBe(
				`Calls for the ${hostileName}'s report · opens voting for Best Speaker`,
			);
			// The tell: no award label and no second role name leaked in.
			expect(detail).not.toContain("Best Table Topic,");
			expect(detail).not.toContain("Timer");
		}
	});

	it("leaves an unrecognised role key verbatim rather than blanking it (#445)", () => {
		// Documented contract: a typo must show up on the page, not silently drop
		// the cue. Reached through a hand-written beat, since no shipped beat has one.
		const typo: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Calls for the {role:tymer}'s report",
			minutes: 1,
		};
		expect(expandRunSheet(sixRoleClub(), [typo])[0].detail).toBe(
			"Calls for the {role:tymer}'s report",
		);
	});

	// `roleNameToken` builds `{role:<key>}` and the resolver's regex accepts only
	// lower-snake, so a key like `timer2` or `Timer` would produce a token nothing
	// resolves and the row would print `{role:…}` to the room mid-meeting.
	//
	// Asserted over the SHIPPED templates rather than by re-checking the regex's
	// character class in the test: a copy of that class here false-fails the moment
	// someone legitimately widens both ends together, and it says nothing about
	// whether a real beat resolves. A leftover `{` on any real row is the actual
	// defect, and this also catches a mistyped `{roles}`/`{awards}`.
	it("leaves no unresolved token on any row of any shipped beat (#445)", () => {
		for (const geIntroducesFunctionaries of [true, false]) {
			const rows = expandRunSheet(
				sixRoleClub(),
				buildRunOfShow({ geIntroducesFunctionaries }),
			);
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) expect(r.detail).not.toContain("{");
		}
	});

	// `applyFlex` rebuilds the row list, so a field-by-field reassembly there would
	// strip `roleKey` and every renamed club would silently lose its spine colour
	// with the suite green. The repo already has this exact test for the `handoff`
	// marker; `roleKey` is the second field with the same exposure.
	it("keeps roleKey through applyFlex and buildTimeline (#445)", () => {
		const flexed = applyFlex(expandRunSheet(sixRoleClub(), RUN_OF_SHOW), 90);
		const timed = buildTimeline(
			flexed.rows,
			"2026-07-07T23:45:00Z",
			"America/Chicago",
		);
		expect(timed.find((r) => r.who.startsWith("Speaker"))?.roleKey).toBe(
			"speaker",
		);
		// The resized row too — that is the arm that rebuilds rather than passes by
		// reference.
		expect(timed.find((r) => r.flex === true)?.roleKey).toBe(
			"table_topics_master",
		);
	});

	it("drops the timer's-report clause, keeping the leader, when there is no Timer", () => {
		const noTimer = sixRoleClub().filter((s) => s.roleKey !== "timer");
		expect(
			voteRows(expandRunSheet(noTimer, RUN_OF_SHOW)).map((r) => [
				r.who,
				r.detail,
			]),
		).toEqual([
			["Toastmaster of the Day · Faisal", "Opens voting for Best Speaker"],
			["Table Topics Master · Rasheed", "Opens voting for Best Table Topics"],
			["General Evaluator · Riyaz", "Opens voting for Best Evaluator"],
		]);
	});

	it("never gives the Timer a row of its own — the report is the leader's cue", () => {
		const rows = expandRunSheet(sixRoleClub(), RUN_OF_SHOW);
		expect(rows.filter((r) => r.who.startsWith("Timer"))).toEqual([]);
	});

	it("still prints the vote, unattributed, at a club that disabled its Toastmaster", () => {
		const noTm = sixRoleClub().filter(
			(s) => s.roleKey !== "toastmaster_of_the_day",
		);
		expect(voteRows(expandRunSheet(noTm, RUN_OF_SHOW))[0]).toMatchObject({
			who: "Toastmaster of the Day",
			detail: "Calls for the Timer's report · opens voting for Best Speaker",
		});
	});

	it("omits a vote whose segment the club does not run", () => {
		const noTopics = sixRoleClub().filter(
			(s) => s.roleKey !== "table_topics_master",
		);
		expect(
			voteRows(expandRunSheet(noTopics, RUN_OF_SHOW)).map((r) => r.detail),
		).toEqual([
			"Calls for the Timer's report · opens voting for Best Speaker",
			"Calls for the Timer's report · opens voting for Best Evaluator",
		]);
	});

	// The two features above (`renderUnowned` and `fallback`) interact rather
	// than only ever firing alone — worth pinning directly, since `beatDetail`
	// is computed once, before the unowned/matched branch, precisely so this
	// combination works; an edit that moved detail resolution inside the
	// `matching.length > 0` arm would break it silently.
	it("renders the bare role name AND drops the timer's-report clause when both the owner and the Timer are missing", () => {
		const noTmNoTimer = sixRoleClub().filter(
			(s) => s.roleKey !== "toastmaster_of_the_day" && s.roleKey !== "timer",
		);
		const rows = voteRows(expandRunSheet(noTmNoTimer, RUN_OF_SHOW));
		expect(rows[0]).toEqual({
			who: "Toastmaster of the Day",
			roleKey: "toastmaster_of_the_day",
			detail: "Opens voting for Best Speaker",
			minutes: 1,
			marks: null,
		});
	});

	// The Toastmaster of the Day covers the WHOLE General Evaluator role at a
	// club that runs no GE (#363). Before that decision this row printed the bare
	// string "General Evaluator" — a role nobody in the room held — while the
	// hand-off directly above it had already relocated to the Toastmaster.
	it("moves the Best-Evaluator vote to the Toastmaster when there is no General Evaluator", () => {
		const noGe = sixRoleClub().filter((s) => s.roleKey !== "general_evaluator");
		expect(
			voteRows(expandRunSheet(noGe, RUN_OF_SHOW)).find((r) =>
				r.detail.endsWith("voting for Best Evaluator"),
			),
		).toEqual({
			who: "Toastmaster of the Day · Faisal",
			roleKey: "toastmaster_of_the_day",
			detail: "Calls for the Timer's report · opens voting for Best Evaluator",
			minutes: 1,
			marks: null,
		});
	});

	// THE beat that proves `fallbacks` had to become plural: two independent
	// triggers on one row. A singular fallback was already spent on the Timer, so
	// the owner could not also relocate.
	it("fires BOTH of the Best-Evaluator vote's fallbacks at a club with neither a General Evaluator nor a Timer", () => {
		const neither = sixRoleClub().filter(
			(s) => s.roleKey !== "general_evaluator" && s.roleKey !== "timer",
		);
		expect(
			voteRows(expandRunSheet(neither, RUN_OF_SHOW)).find((r) =>
				r.detail.endsWith("voting for Best Evaluator"),
			),
		).toEqual({
			who: "Toastmaster of the Day · Faisal",
			roleKey: "toastmaster_of_the_day",
			detail: "Opens voting for Best Evaluator",
			minutes: 1,
			marks: null,
		});
	});

	// The vote beat keeps `renderUnowned` as the backstop for the club where the
	// fallback has nowhere to fall back TO. The bare role name is now the
	// Toastmaster's, because that is the role the beat resolved to.
	it("still prints the Best-Evaluator vote unattributed when neither the GE nor the Toastmaster exists", () => {
		const neither = sixRoleClub().filter(
			(s) =>
				s.roleKey !== "general_evaluator" &&
				s.roleKey !== "toastmaster_of_the_day",
		);
		expect(
			voteRows(expandRunSheet(neither, RUN_OF_SHOW)).find((r) =>
				r.detail.endsWith("voting for Best Evaluator"),
			),
		).toEqual({
			who: "Toastmaster of the Day",
			roleKey: "toastmaster_of_the_day",
			detail: "Calls for the Timer's report · opens voting for Best Evaluator",
			minutes: 1,
			marks: null,
		});
	});
});

/**
 * The Toastmaster of the Day covers the whole General Evaluator role at a club
 * that runs no GE (#363) — all five GE-owned beats, not the one the old
 * `renderUnowned` flag happened to keep.
 *
 * The functionary-reports beat is the one with teeth: without this, a club that
 * runs a Timer, an Ah-Counter and a Grammarian but no General Evaluator
 * introduced all three at the top of the meeting and then never cued a single
 * one to report.
 */
describe("the Toastmaster covers the General Evaluator's role (#363)", () => {
	const noGe = () =>
		sixRoleClub().filter((s) => s.roleKey !== "general_evaluator");

	/** The five beats the General Evaluator owns, as they read once relocated.
	 *  RESOLVED details: this club runs one reporting functionary (the Timer), so
	 *  the reports row names it (#584). */
	const GE_STRETCH = [
		"Introduces the speech evaluators",
		"Calls for the Timer's report · opens voting for Best Evaluator",
		"Evaluates the evaluators",
		"Calls for the Timer to report",
		"Overall meeting evaluation",
	];

	it("puts all five of the GE's beats on the Toastmaster, in order", () => {
		const rows = expandRunSheet(noGe(), RUN_OF_SHOW);
		expect(
			rows
				.filter((r) => GE_STRETCH.includes(r.detail))
				.map((r) => [r.who, r.detail]),
		).toEqual(GE_STRETCH.map((d) => ["Toastmaster of the Day · Faisal", d]));
	});

	it("never names the General Evaluator anywhere on the printed agenda", () => {
		const rows = expandRunSheet(noGe(), RUN_OF_SHOW);
		expect(rows.filter((r) => r.who.includes("General Evaluator"))).toEqual([]);
		expect(
			rows.filter((r) => r.detail.includes("the General Evaluator")),
		).toEqual([]);
	});

	it("calls for the functionary reports, which a no-GE club used to lose entirely", () => {
		// The regression this whole change exists for: the Timer is introduced at
		// the top of the meeting, so somebody has to cue the report.
		const rows = expandRunSheet(noGe(), RUN_OF_SHOW);
		expect(
			rows.find((r) => r.detail === "Calls for the Timer to report"),
		).toEqual({
			who: "Toastmaster of the Day · Faisal",
			roleKey: "toastmaster_of_the_day",
			detail: "Calls for the Timer to report",
			minutes: 3,
			marks: null,
		});
	});

	it("drops the 'returns control to the Toastmaster' clause when the Toastmaster is the one giving it", () => {
		// The clause is correct when the General Evaluator hands the room back and
		// nonsense when the Toastmaster never gave it away, so the same fallback
		// entry that moves the owner also rewrites the detail.
		const withGe = expandRunSheet(sixRoleClub(), RUN_OF_SHOW);
		expect(withGe.find((r) => r.detail.startsWith("Overall meeting"))).toEqual({
			who: "General Evaluator · Riyaz",
			roleKey: "general_evaluator",
			detail: "Overall meeting evaluation · returns control to the Toastmaster",
			minutes: 2,
			marks: null,
		});
		const covered = expandRunSheet(noGe(), RUN_OF_SHOW);
		expect(covered.find((r) => r.detail.startsWith("Overall meeting"))).toEqual(
			{
				who: "Toastmaster of the Day · Faisal",
				roleKey: "toastmaster_of_the_day",
				detail: "Overall meeting evaluation",
				minutes: 2,
				marks: null,
			},
		);
	});

	it("keeps the whole run-of-show the same length — a covered beat is still the same beat", () => {
		const total = (rs: AgendaRow[]) => rs.reduce((n, r) => n + r.minutes, 0);
		expect(total(expandRunSheet(noGe(), RUN_OF_SHOW))).toBe(
			total(expandRunSheet(sixRoleClub(), RUN_OF_SHOW)),
		);
	});

	it("degrades to nothing — not to ghost rows — when there is no Toastmaster either", () => {
		// Nobody to cover, so four of the five beats go. The Best-Evaluator vote is
		// the exception BY DESIGN (`renderUnowned`): it belongs to the evaluation
		// segment, which the club still runs, so the cue survives unattributed.
		const rows = expandRunSheet(
			sixRoleClub().filter(
				(s) =>
					s.roleKey !== "general_evaluator" &&
					s.roleKey !== "toastmaster_of_the_day",
			),
			RUN_OF_SHOW,
		);
		expect(
			rows.filter((r) => GE_STRETCH.includes(r.detail)).map((r) => r.detail),
		).toEqual([
			"Calls for the Timer's report · opens voting for Best Evaluator",
		]);
		// …and that one row names a role, never a person who does not exist.
		expect(rows.find((r) => GE_STRETCH.includes(r.detail))?.who).toBe(
			"Toastmaster of the Day",
		);
	});

	it("leaves a club that DOES run a General Evaluator untouched", () => {
		const rows = expandRunSheet(sixRoleClub(), RUN_OF_SHOW);
		expect(
			rows
				.filter((r) =>
					[
						...GE_STRETCH.slice(0, 4),
						"Overall meeting evaluation · returns control to the Toastmaster",
					].includes(r.detail),
				)
				.map((r) => r.who),
		).toEqual(Array(5).fill("General Evaluator · Riyaz"));
	});
});

/**
 * "Evaluates the evaluators" is gated on the EVALUATORS as of #363, reversing
 * #367's decision that it followed the General Evaluator alone.
 *
 * #367's argument was symmetry — the beat is the GE's, so it should live and
 * die with the GE — but that defended wrong copy: a row reading "Evaluates the
 * evaluators" at a club that runs none is nonsense no matter who owns it. The
 * Toastmaster covering the role (above) did not create that, it just made it
 * reachable by a second route and put it in front of more clubs.
 */
describe("the evaluator evaluation needs evaluators (#363, reverses #367)", () => {
	const evaluatorEvaluation = (slots: AgendaSlot[]) =>
		expandRunSheet(slots, RUN_OF_SHOW).find(
			(r) => r.detail === "Evaluates the evaluators",
		);
	const noEvaluators = () =>
		sixRoleClub().filter((s) => s.roleKey !== "evaluator");

	it("drops the beat at a club with a General Evaluator but no evaluators", () => {
		expect(evaluatorEvaluation(noEvaluators())).toBeUndefined();
	});

	it("drops it for a covering Toastmaster too — the gate is the segment, not the owner", () => {
		expect(
			evaluatorEvaluation(
				noEvaluators().filter((s) => s.roleKey !== "general_evaluator"),
			),
		).toBeUndefined();
	});

	it("keeps the GE's other closing beats, which are not evaluator-gated", () => {
		const rows = expandRunSheet(noEvaluators(), RUN_OF_SHOW);
		expect(rows.map((r) => r.detail)).toContain(
			"Calls for the Timer to report",
		);
		expect(rows.map((r) => r.detail)).toContain(
			"Overall meeting evaluation · returns control to the Toastmaster",
		);
	});

	it("still renders it when the club DOES run evaluators", () => {
		// Not vacuous: the three negatives above would pass if the beat had simply
		// been deleted from the template.
		expect(evaluatorEvaluation(sixRoleClub())).toMatchObject({
			who: "General Evaluator · Riyaz",
			detail: "Evaluates the evaluators",
		});
	});
});

describe("hand-off beats — who introduces whom (#363)", () => {
	const handoffs = (rows: AgendaRow[]) =>
		rows.filter((r) => r.handoff === true);

	it("every hand-off books zero minutes", () => {
		for (const flag of [true, false]) {
			const rows = expandRunSheet(
				sixRoleClub(),
				buildRunOfShow({ geIntroducesFunctionaries: flag }),
			);
			expect(handoffs(rows).every((r) => r.minutes === 0)).toBe(true);
		}
	});

	it("states the full MCF chain, in order", () => {
		const rows = expandRunSheet(
			sixRoleClub(),
			buildRunOfShow({ geIntroducesFunctionaries: true }),
		);
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			[
				"Toastmaster of the Day · Faisal",
				"Introduces the General Evaluator: Riyaz",
			],
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			[
				"Toastmaster of the Day · Faisal",
				"Introduces the Table Topics Master: Rasheed",
			],
			[
				"Table Topics Master · Rasheed",
				"Introduces the General Evaluator: Riyaz",
			],
			["General Evaluator · Riyaz", "Introduces the speech evaluators"],
		]);
	});

	it("omits the opening GE introduction in the standard flow, where the GE has no early appearance", () => {
		const rows = expandRunSheet(
			sixRoleClub(),
			buildRunOfShow({ geIntroducesFunctionaries: false }),
		);
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			[
				"Toastmaster of the Day · Faisal",
				"Introduces the Table Topics Master: Rasheed",
			],
			[
				"Table Topics Master · Rasheed",
				"Introduces the General Evaluator: Riyaz",
			],
			["General Evaluator · Riyaz", "Introduces the speech evaluators"],
		]);
	});

	it("hands to the GE from the Toastmaster when the club runs no Table Topics", () => {
		const noTopics = sixRoleClub().filter(
			(s) => s.roleKey !== "table_topics_master",
		);
		const rows = expandRunSheet(noTopics, RUN_OF_SHOW);
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			[
				"Toastmaster of the Day · Faisal",
				"Introduces the General Evaluator: Riyaz",
			],
			["General Evaluator · Riyaz", "Introduces the speech evaluators"],
		]);
	});

	it("has the Toastmaster introduce the evaluators when the club runs no General Evaluator", () => {
		const noGe = sixRoleClub().filter((s) => s.roleKey !== "general_evaluator");
		const rows = expandRunSheet(noGe, RUN_OF_SHOW);
		// The full list, not just the rebound row: it also pins that a club with no
		// General Evaluator is never told to introduce one.
		expect(handoffs(rows).map((r) => [r.who, r.detail])).toEqual([
			["Toastmaster of the Day · Faisal", "Introduces the speakers"],
			[
				"Toastmaster of the Day · Faisal",
				"Introduces the Table Topics Master: Rasheed",
			],
			["Toastmaster of the Day · Faisal", "Introduces the speech evaluators"],
		]);
	});

	it("promises no segment the club does not run", () => {
		const bare = [
			slot({
				id: "tm",
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
		];
		expect(handoffs(expandRunSheet(bare, RUN_OF_SHOW))).toEqual([]);
	});

	it("leaves both variants the same total length (the old handback booked a minute)", () => {
		const total = (rs: AgendaRow[]) => rs.reduce((n, r) => n + r.minutes, 0);
		expect(
			total(
				expandRunSheet(
					sixRoleClub(),
					buildRunOfShow({ geIntroducesFunctionaries: true }),
				),
			),
		).toBe(
			total(
				expandRunSheet(
					sixRoleClub(),
					buildRunOfShow({ geIntroducesFunctionaries: false }),
				),
			),
		);
	});

	// The print route runs `expandRunSheet` → `applyFlex` → `buildTimeline` before
	// the four layouts ever see a row, and each link is pinned on its own: this
	// file for the marker, `agenda-timing.test.ts` for `buildTimeline` carrying
	// it, `meeting-agenda-print.test.tsx` for the band. `applyFlex` is the link in
	// the middle with nothing on it. It rebuilds the list — the flex row through
	// `{ ...r, minutes }`, the rest by reference — so `handoff` survives only
	// because both arms preserve the whole row; an edit that assembled rows
	// field-by-field (the same hazard `buildTimeline`'s test names) would strip
	// every hand-off back to a full segment block with the suite still green.
	// `flex` is already safe there — `flexBannerMessage` reads it off the result —
	// which is exactly why `handoff` can rot alone.
	it("keeps the hand-off markers through applyFlex, the print route's own pipeline", () => {
		const rows = expandRunSheet(sixRoleClub(), RUN_OF_SHOW);
		const flexed = applyFlex(rows, 90);
		// The Table Topics row really was resized (10 ⇒ its 25-min cap), so this
		// exercises the rebuilding arm rather than `applyFlex`'s no-flex-row
		// shortcut, which returns the input array untouched.
		expect(flexed.rows.find((r) => r.flex === true)?.minutes).toBe(
			TABLE_TOPICS_MAX,
		);
		const timed = buildTimeline(
			flexed.rows,
			"2026-07-07T23:45:00Z",
			"America/Chicago",
		);
		expect(
			timed.filter((r) => r.handoff === true).map((r) => r.detail),
		).toEqual([
			"Introduces the speakers",
			"Introduces the Table Topics Master: Rasheed",
			"Introduces the General Evaluator: Riyaz",
			"Introduces the speech evaluators",
		]);
	});
});

/**
 * The three hand-offs the club's own agenda states as a TRAILING CLAUSE on an
 * existing row rather than as a row of its own (#363), plus the two places we
 * printed something the club does not do (noting exits, holding elections).
 */
describe("closing and opening hand-off clauses (#363)", () => {
	const detailFor = (rows: AgendaRow[], who: string) =>
		rows.filter((r) => r.who.startsWith(who)).map((r) => r.detail);

	const club = () => [
		slot({
			id: "tm",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			category: "leadership",
			assigneeName: "Faisal",
		}),
		slot({
			id: "sp",
			roleKey: "speaker",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
		}),
		slot({
			id: "ge",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
			category: "leadership",
			assigneeName: "Riyaz",
		}),
	];

	it("has the Sergeant-at-Arms introduce the President, and does not mention exits", () => {
		expect(
			detailFor(expandRunSheet(club(), RUN_OF_SHOW), "Sergeant-at-Arms"),
		).toEqual(["Call to Order · phones silent · introduces the President"]);
	});

	it("has the General Evaluator return control to the Toastmaster", () => {
		expect(
			detailFor(expandRunSheet(club(), RUN_OF_SHOW), "General Evaluator"),
		).toContain(
			"Overall meeting evaluation · returns control to the Toastmaster",
		);
	});

	it("has the Toastmaster hand over to the President after the awards", () => {
		const rows = expandRunSheet(club(), RUN_OF_SHOW);
		expect(rows.find((r) => r.detail.startsWith("Awards"))?.detail).toBe(
			"Awards · Best Speaker · hands over to the President",
		);
	});

	it("closes on announcements, not elections", () => {
		const details = detailFor(expandRunSheet(club(), RUN_OF_SHOW), "President");
		expect(details).toContain("Club business · announcements");
		expect(details).toContain("Adjourns");
		expect(details.join(" ")).not.toMatch(/election/i);
	});
});

describe("expandRunSheet — vote beats are gated on their segment (#367)", () => {
	const timer = slot({
		roleName: "Timer",
		category: "functionary",
		assigneeName: "T",
	});
	const speaker = slot({
		id: "sp",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "S",
	});
	const ttm = slot({
		id: "tt",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "M",
	});
	const evaluator = slot({
		id: "ev",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "E",
	});

	it("prints no vote at all for a club that runs none of the three segments", () => {
		const rows = expandRunSheet([timer]);
		expect(rows.some((r) => r.detail.includes("voting for Best"))).toBe(false);
	});

	it("prints only the votes whose segment is on the agenda", () => {
		// A club with no Table Topics Master must not be told to vote for a Best
		// Table Topic — the segment is not on its agenda.
		const rows = expandRunSheet([timer, speaker, evaluator]);
		const votes = rows
			.filter((r) => r.detail.includes("voting for Best"))
			.map((r) => r.detail);
		expect(votes).toEqual([
			"Calls for the Timer's report · opens voting for Best Speaker",
			"Calls for the Timer's report · opens voting for Best Evaluator",
		]);
	});

	it("prints the Table Topics vote once the club runs the segment", () => {
		const rows = expandRunSheet([timer, ttm]);
		expect(
			rows.some(
				(r) =>
					r.detail ===
					"Calls for the Timer's report · opens voting for Best Table Topics",
			),
		).toBe(true);
	});
});

describe("expandRunSheet — the functionary-intro and functionary-reports beats (#367)", () => {
	const totd = slot({
		roleName: "Toastmaster of the Day",
		category: "leadership",
		assigneeName: "Dana",
	});
	const ge = slot({
		roleName: "General Evaluator",
		category: "leadership",
		assigneeName: "Priya",
	});
	const grammarian = slot({
		id: "gr",
		roleName: "Grammarian",
		category: "functionary",
		assigneeName: "Gina",
	});
	const timer = slot({
		id: "ti",
		roleName: "Timer",
		category: "functionary",
		assigneeName: "Tariq",
	});
	const speaker = slot({
		id: "sp",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "Sam",
	});
	// The functionary intro specifically — the hand-off rows (#363) also start
	// "Introduces the", so the beat is identified by the clause only it carries.
	// `includes`, not `endsWith`: since #508 the clause is no longer last, because
	// a club with a Grammarian appends the Word-of-the-Day cue after it.
	const introRow = (rows: { detail: string }[]) =>
		rows.find((r) => r.detail.includes("; each explains their role"));
	// The functionary-reports row, same idea (#584). Since that beat started
	// naming its roles, the NAMES cannot identify it — `{roles}` resolves to
	// whatever this club runs, and to the empty string at a club that runs none,
	// which is precisely the case several tests below assert is ABSENT. Matching
	// the old literal would have made every one of those negatives pass
	// vacuously, against a string the code can no longer produce. The trailing
	// clause is invariant and unique: no other beat's detail ends "to report"
	// ("Calls for the {role:timer}'s report · opens voting…" is a different beat
	// and a different ending).
	const reportsRow = (rows: { detail: string }[]) =>
		rows.find((r) => r.detail.endsWith("to report"));

	it("omits the functionary intro when there are no functionary slots, even with a Toastmaster slot", () => {
		expect(introRow(expandRunSheet([totd]))).toBeUndefined();
	});

	it("renders the functionary intro when at least one functionary slot exists", () => {
		const rows = expandRunSheet([totd, grammarian]);
		expect(
			rows.some(
				(r) =>
					r.who === "Toastmaster of the Day · Dana" &&
					r.detail ===
						"Introduces the Grammarian; each explains their role · the Grammarian gives the Word of the Day",
			),
		).toBe(true);
	});

	it("the functionary intro names ONLY the functionaries the club actually runs (#367)", () => {
		// Two of the four standard functionaries ⇒ both named, in slot order,
		// and the two the club does not run are not mentioned.
		expect(introRow(expandRunSheet([totd, timer, grammarian]))?.detail).toBe(
			"Introduces the Timer & Grammarian; each explains their role · the Grammarian gives the Word of the Day",
		);
		expect(introRow(expandRunSheet([totd, grammarian]))?.detail).toBe(
			"Introduces the Grammarian; each explains their role · the Grammarian gives the Word of the Day",
		);
	});

	it("the functionary intro uses the club's OWN name for a renamed functionary (#368)", () => {
		const rows = expandRunSheet([
			totd,
			slot({
				id: "gr",
				roleName: "Wordsmith",
				roleKey: "grammarian",
				category: "functionary",
				assigneeName: "Gina",
			}),
		]);
		expect(introRow(rows)?.detail).toBe(
			"Introduces the Wordsmith; each explains their role · the Wordsmith gives the Word of the Day",
		);
	});

	it("substitutes a club's role name LITERALLY, dollar signs and all", () => {
		// `String.replace` reads `$&`, "$`", `$'` and `$n` in a REPLACEMENT STRING
		// as back-references, and `roleName` is typed verbatim by an admin with no
		// character validation. Joined as a string, "Timer $`" spliced the copy
		// BEFORE the token back into the row ("Introduces the Timer Introduces the
		// ; each explains their role") on the printed agenda, the projected deck
		// and the .pptx alike. A replacer function is what makes it literal.
		const rows = expandRunSheet([
			totd,
			slot({
				id: "tm",
				roleName: "Timer $` $& $'",
				roleKey: "timer",
				category: "functionary",
				assigneeName: "Bilal",
			}),
		]);
		expect(introRow(rows)?.detail).toBe(
			"Introduces the Timer $` $& $'; each explains their role",
		);
	});

	it("omits the functionary reports when there are no functionary slots, even with a GE slot", () => {
		// An evaluator rides along so the evaluator-evaluation beat's own gate
		// (#363) is satisfied — this test is about the FUNCTIONARY gate, and
		// without one it would pass for the wrong reason.
		const evaluator = slot({
			id: "ev",
			roleKey: "evaluator",
			roleName: "Evaluator",
			category: "evaluator",
			assigneeName: "Sudheer",
		});
		const rows = expandRunSheet([ge, evaluator]);
		expect(reportsRow(rows)).toBeUndefined();
		// But the OTHER two GE beats (not functionary-gated) still render.
		expect(rows.some((r) => r.detail === "Evaluates the evaluators")).toBe(
			true,
		);
		// WITHOUT the trailing clause: this club has no Toastmaster of the Day, so
		// there is nobody to return control to, and "the Toastmaster" is a role
		// name that exists at no club under that spelling (#449).
		expect(rows.some((r) => r.detail === "Overall meeting evaluation")).toBe(
			true,
		);
		expect(
			rows.some(
				(r) =>
					r.detail ===
					"Overall meeting evaluation · returns control to the Toastmaster",
			),
		).toBe(false);
	});

	it("renders the functionary reports when the GE slot exists and at least one functionary slot exists", () => {
		const rows = expandRunSheet([ge, grammarian]);
		expect(reportsRow(rows)).toMatchObject({
			who: "General Evaluator · Priya",
			detail: "Calls for the Grammarian to report",
		});
	});

	it("the functionary intro names a club-invented functionary, and renders for a club that runs ONLY custom ones (#371)", () => {
		// #368's disable lifecycle lets a club turn off all four standard
		// functionaries and run its own. Before #371 that lost both functionary
		// beats from the printed agenda and both slides from the deck, while the
		// legend still listed the very same people.
		const jokeMaster = slot({
			id: "jm",
			roleKey: null,
			roleName: "Joke Master",
			category: "functionary",
			assigneeName: "Nadia",
		});
		const wordMaster = slot({
			id: "wm",
			roleKey: null,
			roleName: "Word Master",
			category: "functionary",
			assigneeName: "Omar",
		});
		expect(
			introRow(expandRunSheet([totd, jokeMaster, wordMaster]))?.detail,
		).toBe(
			"Introduces the Joke Master & Word Master; each explains their role",
		);
	});

	it("the functionary intro names a custom functionary ALONGSIDE the standard ones — the same list the slide shows (#371)", () => {
		const jokeMaster = slot({
			id: "jm",
			roleKey: null,
			roleName: "Joke Master",
			category: "functionary",
			assigneeName: "Nadia",
		});
		expect(
			introRow(expandRunSheet([totd, timer, grammarian, jokeMaster]))?.detail,
		).toBe(
			"Introduces the Timer, Grammarian & Joke Master; each explains their role · the Grammarian gives the Word of the Day",
		);
	});

	it("the functionary reports are omitted for a Vote-Counter-only club — a Vote Counter gives no report (#371)", () => {
		const voteCounter = slot({
			id: "vc",
			roleName: "Vote Counter",
			category: "functionary",
			assigneeName: "Omar",
		});
		const rows = expandRunSheet([totd, ge, voteCounter]);
		expect(reportsRow(rows)).toBeUndefined();
		// The Vote Counter is still a functionary: the intro beat introduces them.
		expect(introRow(rows)?.detail).toBe(
			"Introduces the Vote Counter; each explains their role",
		);
	});

	it("both functionary beats are omitted when the only candidate is a standard KEY recategorised out of the functionaries (#371)", () => {
		// `applyRoleDefinitionUpdate` lets an admin change a role's category, so a
		// timer-keyed slot filed under "leadership" is reachable. The category is
		// the definition, so this club runs no functionaries — and crucially the
		// beat must be OMITTED, not rendered off the standard key list with an
		// empty `{roles}` ("Introduces the ; each explains their role") while the
		// deck, which reads `hasAnyFunctionaryRole`, drops the slide.
		const recategorisedTimer = slot({
			id: "ti",
			roleKey: "timer",
			roleName: "Timer",
			category: "leadership",
			assigneeName: "Tariq",
		});
		const rows = expandRunSheet([totd, ge, recategorisedTimer]);
		expect(introRow(rows)).toBeUndefined();
		expect(reportsRow(rows)).toBeUndefined();
	});

	it("the functionary reports render for a club whose only functionary is a custom one (#371)", () => {
		const rows = expandRunSheet([
			ge,
			slot({
				id: "jm",
				roleKey: null,
				roleName: "Joke Master",
				category: "functionary",
				assigneeName: "Nadia",
			}),
		]);
		// The club's OWN role name reaches the row, which is the whole point of
		// resolving `{roles}` against the category rather than our four keys.
		expect(reportsRow(rows)?.detail).toBe(
			"Calls for the Joke Master to report",
		);
	});

	it("MCF variant: the GE-owned functionary intro is still omitted when there are no functionary slots, despite a GE slot existing", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(introRow(expandRunSheet([totd, ge], template))).toBeUndefined();
	});

	// This used to pin the defect rather than the fix (#449): with no
	// functionaries the opening hand-off into the General Evaluator still fired,
	// landing adjacent to the speakers hand-off under the same owner and the same
	// clock stamp — the room handed over and taken straight back, for an intro
	// that never happened. The beat now carries `alsoRequiresGroup:
	// "functionaries"`, so it does not fire at all here.
	//
	// The render-side hand-off band this motivated (#363) is still worth having:
	// `meeting-agenda-print.test.tsx` guards adjacent 0-minute rows generally,
	// and other shapes still produce them.
	it("MCF variant: with a GE and speakers but no functionaries, the opening GE hand-off does not fire", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, ge, speaker], template);

		// ONE, not zero: two beats carry this detail. The OPENING hand-off is gone
		// (nothing to hand over for), while the post-Table-Topics one still fires
		// and falls back to the Toastmaster because the club runs no Table Topics
		// Master — that hand-back is real, the room does have to reach the GE for
		// the evaluation segment.
		expect(
			rows.filter((r) =>
				r.detail.startsWith("Introduces the General Evaluator"),
			),
		).toHaveLength(1);

		// The speakers hand-off is unaffected — this is a narrowing of one beat's
		// gate, not a change to the hand-off mechanism.
		const speakersHandoff = rows.findIndex((r) =>
			r.detail.startsWith("Introduces the speakers"),
		);
		expect(speakersHandoff).toBeGreaterThanOrEqual(0);
		expect(rows[speakersHandoff]).toMatchObject({
			who: "Toastmaster of the Day · Dana",
			handoff: true,
			minutes: 0,
		});
	});

	// The GE is still introduced when there IS something to hand over for, which
	// is what keeps the fix above a narrowing rather than a removal.
	it("MCF variant: with a GE AND functionaries, the opening hand-off fires", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, ge, grammarian, speaker], template);

		// BOTH now: the opening hand-off (there are functionaries to introduce)
		// and the evaluation one. They are far apart — the functionary intro, the
		// speakers hand-off and the speech all sit between them — so the adjacency
		// suppression does not apply and both are genuinely needed.
		expect(
			rows.filter((r) =>
				r.detail.startsWith("Introduces the General Evaluator"),
			),
		).toHaveLength(2);
	});

	it("MCF variant: the Toastmaster covers the functionary intro when the club runs no General Evaluator (#363)", () => {
		// The intro beat is GE-owned under this variant, so it needs the same
		// cover as the GE's other beats. Without it a club with functionaries and
		// no GE was never told to introduce them — while the next GE-owned beat,
		// which DID have the cover, still called for their reports.
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, timer, grammarian], template);
		expect(introRow(rows)).toEqual({
			who: "Toastmaster of the Day · Dana",
			roleKey: "toastmaster_of_the_day",
			detail:
				"Introduces the Timer & Grammarian; each explains their role · the Grammarian gives the Word of the Day",
			minutes: 3,
			marks: null,
		});
		// …and the same Toastmaster then cues those reports, so the two rows agree
		// about who is running the room.
		expect(reportsRow(rows)).toMatchObject({
			who: "Toastmaster of the Day · Dana",
			detail: "Calls for the Timer & Grammarian to report",
		});
	});

	it("MCF variant: the functionary intro still goes when there is no General Evaluator AND no Toastmaster to cover", () => {
		// The cover has nowhere to land, so the beat drops — the same way the GE's
		// other non-`renderUnowned` beats do. Pins that the fallback added above
		// did not turn the beat unconditional.
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(
			introRow(expandRunSheet([timer, grammarian], template)),
		).toBeUndefined();
	});

	it("MCF variant: the functionary intro renders owned by the General Evaluator when GE and a functionary both exist", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, ge, grammarian], template);
		expect(introRow(rows)).toMatchObject({
			who: "General Evaluator · Priya",
			detail:
				"Introduces the Grammarian; each explains their role · the Grammarian gives the Word of the Day",
		});
		// It is NOT owned by the Toastmaster in this variant.
		expect(
			rows.some(
				(r) =>
					r.who.startsWith("Toastmaster of the Day") &&
					r.detail.endsWith("; each explains their role"),
			),
		).toBe(false);
	});

	// The speakers hand-off. Universal since #363, but its interaction with the
	// GE-owned functionary intro is what these cases are about.
	const speakersHandoffRow = (rows: { detail: string }[]) =>
		rows.find((r) => r.detail.startsWith("Introduces the speakers"));

	it("MCF variant: the Toastmaster introduces the speakers, in a row between the GE's intro and the first speech", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, ge, grammarian, speaker], template);
		expect(speakersHandoffRow(rows)).toMatchObject({
			who: "Toastmaster of the Day · Dana",
			detail: "Introduces the speakers",
		});
		const at = (pred: (r: { detail: string }) => boolean) =>
			rows.findIndex(pred);
		expect(
			at((r) => r.detail.endsWith("; each explains their role")),
		).toBeLessThan(at((r) => r.detail.startsWith("Introduces the speakers")));
		expect(
			at((r) => r.detail.startsWith("Introduces the speakers")),
		).toBeLessThan(at((r) => r.detail === "Prepared speech"));
	});

	it("MCF variant: no speakers hand-off when the club runs no speakers — there is nobody to introduce", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(
			speakersHandoffRow(expandRunSheet([totd, ge, grammarian], template)),
		).toBeUndefined();
	});

	it("MCF variant: no speakers hand-off without a Toastmaster slot", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(
			speakersHandoffRow(expandRunSheet([ge, grammarian, speaker], template)),
		).toBeUndefined();
	});

	// Was "default variant: no handback row — the Toastmaster ran the intro and
	// never left". #363 makes the row universal: the Toastmaster IS still holding
	// the room, and the agenda now says so rather than leaving it implied.
	it("default variant: the speakers hand-off is there too, owned by the Toastmaster", () => {
		expect(
			speakersHandoffRow(expandRunSheet([totd, ge, grammarian, speaker])),
		).toEqual({
			who: "Toastmaster of the Day · Dana",
			roleKey: "toastmaster_of_the_day",
			// The detail names NOBODY — #585's measurement, unchanged. The names
			// travel in `introduces` below, and only the two-page layouts render
			// them (#578). A whole-object `toEqual` is deliberate here: it is what
			// caught the new field being added, which is exactly the review a row
			// shape change deserves.
			detail: "Introduces the speakers",
			introduces: ["Sam"],
			minutes: 0,
			marks: null,
			handoff: true,
		});
	});
});

// The deck gates its functionary slides on this exact predicate rather than a
// rule of its own, which is what keeps print and deck from disagreeing (#367).
describe("hasAnyFunctionaryRole", () => {
	it("is false for no slots and for a leadership-only crew", () => {
		expect(hasAnyFunctionaryRole([])).toBe(false);
		expect(
			hasAnyFunctionaryRole([
				slot({ roleName: "Toastmaster of the Day", category: "leadership" }),
				slot({ roleName: "General Evaluator", category: "leadership" }),
				slot({ roleName: "Speaker", category: "speaker" }),
			]),
		).toBe(false);
	});

	it("is true for any of the four standard functionaries, claimed or open", () => {
		for (const roleName of [
			"Timer",
			"Ah-Counter",
			"Grammarian",
			"Vote Counter",
		])
			expect(hasAnyFunctionaryRole([slot({ roleName })])).toBe(true);
	});

	it("matches by role key, so a renamed functionary still counts (#368)", () => {
		expect(
			hasAnyFunctionaryRole([
				slot({ roleName: "Wordsmith", roleKey: "grammarian" }),
			]),
		).toBe(true);
	});

	// Was: "ignores a club-invented functionary that maps to no standard role".
	// That pinned the pre-#371 narrowing, where this predicate resolved against
	// the four standard keys while `buildLegend` filtered on the category — the
	// exact split #371 removes. Updated deliberately, in the direction the
	// triage decided: the category is the definition.
	it("counts a club-invented functionary, which is the club telling us it is one (#371)", () => {
		expect(
			hasAnyFunctionaryRole([
				slot({
					roleKey: null,
					roleName: "Joke Master",
					category: "functionary",
				}),
			]),
		).toBe(true);
	});

	it("is false for a standard KEY carried by a non-functionary category", () => {
		// Membership is the category, full stop — the key only says which role it
		// is, so a club that recategorised its Timer out of the functionaries is
		// taken at its word here as it already was in the legend.
		expect(
			hasAnyFunctionaryRole([
				slot({ roleKey: "timer", roleName: "Timer", category: "leadership" }),
			]),
		).toBe(false);
	});
});

// The functionary-reports beat's gate, and the deck's matching slide (#371).
// Narrower than `hasAnyFunctionaryRole` by exactly one standard role: the Vote
// Counter, who is a functionary but gives no report.
describe("hasAnyReportingFunctionaryRole (#371)", () => {
	it("is false for no slots and for a leadership-only crew", () => {
		expect(hasAnyReportingFunctionaryRole([])).toBe(false);
		expect(
			hasAnyReportingFunctionaryRole([
				slot({ roleName: "Toastmaster of the Day", category: "leadership" }),
			]),
		).toBe(false);
	});

	it("is true for the three standard functionaries that report", () => {
		for (const roleName of ["Timer", "Ah-Counter", "Grammarian"])
			expect(hasAnyReportingFunctionaryRole([slot({ roleName })])).toBe(true);
	});

	it("is FALSE for a Vote-Counter-only club, though the intro beat still introduces them", () => {
		const voteCounter = slot({ roleName: "Vote Counter" });
		expect(hasAnyReportingFunctionaryRole([voteCounter])).toBe(false);
		expect(hasAnyFunctionaryRole([voteCounter])).toBe(true);
	});

	it("is true for a club-invented functionary", () => {
		expect(
			hasAnyReportingFunctionaryRole([
				slot({
					roleKey: null,
					roleName: "Joke Master",
					category: "functionary",
				}),
			]),
		).toBe(true);
	});
});

describe("expandRunSheet flex marker", () => {
	const ttm = slot({
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "T",
	});

	it("marks exactly one row — the Table Topics row — as flex", () => {
		const rows = expandRunSheet([ttm]);
		const flexed = rows.filter((r) => r.flex === true);
		expect(flexed).toHaveLength(1);
		expect(flexed[0].who).toContain("Table Topics");
	});

	it("does not mark any row when the template has no flex beat", () => {
		const noFlex = RUN_OF_SHOW.map((b) => ({ ...b, flex: undefined }));
		const rows = expandRunSheet([ttm], noFlex);
		expect(rows.some((r) => r.flex === true)).toBe(false);
	});

	it("marks no row as flex when the Table Topics role itself has no slots", () => {
		const rows = expandRunSheet([]);
		expect(rows.some((r) => r.flex === true)).toBe(false);
	});
});

describe("applyFlex", () => {
	// Helper: build rows with a marked flex row of `flexMin`, plus `fixed` fixed minutes.
	function rowsFixture(fixed: number, flexMin: number): AgendaRow[] {
		return [
			{ who: "Fixed", detail: "", minutes: fixed, marks: null },
			{
				who: "Table Topics",
				detail: "",
				minutes: flexMin,
				marks: null,
				flex: true,
			},
		];
	}

	it("fills exactly when the remainder is within bounds", () => {
		const res = applyFlex(rowsFixture(50, 10), 63); // wants 13
		expect(res.rows[1].minutes).toBe(13);
		expect(res.projectedMinutes).toBe(63);
		expect(res.status).toBe("exact");
		expect(res.deltaMinutes).toBe(0);
	});

	it("clamps to MAX and reports under when there is too much slack", () => {
		const res = applyFlex(rowsFixture(40, 10), 90); // wants 50, capped at 25
		expect(res.rows[1].minutes).toBe(TABLE_TOPICS_MAX);
		expect(res.projectedMinutes).toBe(65);
		expect(res.status).toBe("under");
		expect(res.deltaMinutes).toBe(-25);
	});

	it("clamps to MIN and reports over when there is too little slack", () => {
		const res = applyFlex(rowsFixture(58, 10), 60); // wants 2, floored at 5
		expect(res.rows[1].minutes).toBe(TABLE_TOPICS_MIN);
		expect(res.projectedMinutes).toBe(63);
		expect(res.status).toBe("over");
		expect(res.deltaMinutes).toBe(3);
	});

	it("treats a sub-tolerance clamp miss as exact (no banner) but still reports the true delta", () => {
		const res = applyFlex(rowsFixture(57, 10), 60); // wants 3, floored at 5 -> +2
		expect(res.rows[1].minutes).toBe(TABLE_TOPICS_MIN);
		expect(res.deltaMinutes).toBe(2);
		expect(Math.abs(res.deltaMinutes)).toBeLessThanOrEqual(
			FLEX_TOLERANCE_MINUTES,
		);
		expect(res.status).toBe("exact"); // |2| <= FLEX_TOLERANCE_MINUTES
	});

	it("does not flex when no row is marked; status reflects the real over/under", () => {
		const rows: AgendaRow[] = [
			{ who: "A", detail: "", minutes: 50, marks: null },
			{ who: "B", detail: "", minutes: 20, marks: null },
		];
		const res = applyFlex(rows, 60); // 70 total, no flex row -> +10
		expect(res.projectedMinutes).toBe(70);
		expect(res.status).toBe("over");
		expect(res.deltaMinutes).toBe(10);
		expect(res.rows).toEqual(rows); // unchanged
	});
});

describe("applyFlex — a flex beat that produced several rows (#448)", () => {
	/** `fixed` minutes of non-flex rows, plus one flex row per entry in `flex`. */
	function multiFixture(fixed: number, flex: number[]): AgendaRow[] {
		return [
			{ who: "Fixed", detail: "", minutes: fixed, marks: null },
			...flex.map((minutes, i) => ({
				who: `Table Topics ${i + 1}`,
				detail: "",
				minutes,
				marks: null,
				flex: true as const,
			})),
		];
	}
	const seg = (r: AgendaRow[]) =>
		r.filter((x) => x.flex === true).reduce((n, x) => n + x.minutes, 0);

	it("clamps the SEGMENT, not one row — the bound is per segment, not per speaker", () => {
		// Pre-#448 only rows[1] resized, so the segment could reach 35 against a
		// 25-min cap while `status` read "exact" and no banner fired at all.
		const res = applyFlex(multiFixture(20, [10, 10]), 100); // wants 80, capped
		expect(seg(res.rows)).toBe(TABLE_TOPICS_MAX);
		expect(res.projectedMinutes).toBe(45);
		expect(res.status).toBe("under");
		expect(res.deltaMinutes).toBe(-55);
	});

	it("reaches the segment floor, so the banner's floor claim is true of every row", () => {
		const res = applyFlex(multiFixture(40, [10, 10]), 40); // wants 0, floored
		expect(seg(res.rows)).toBe(TABLE_TOPICS_MIN);
		expect(res.projectedMinutes).toBe(45);
		expect(res.deltaMinutes).toBe(5);
	});

	it("absorbs an in-bounds remainder across the rows", () => {
		const res = applyFlex(multiFixture(40, [10, 10]), 60); // segment wants 20
		expect(res.rows.filter((r) => r.flex).map((r) => r.minutes)).toEqual([
			10, 10,
		]);
		expect(res.projectedMinutes).toBe(60);
		expect(res.status).toBe("exact");
	});

	it("keeps the total exact when the segment does not divide evenly", () => {
		const res = applyFlex(multiFixture(40, [10, 10]), 61); // segment wants 21
		expect(res.rows.filter((r) => r.flex).map((r) => r.minutes)).toEqual([
			11, 10,
		]);
		expect(seg(res.rows)).toBe(21);
		expect(res.projectedMinutes).toBe(61);
	});

	it("splits three ways without losing or inventing a minute", () => {
		const res = applyFlex(multiFixture(40, [10, 10, 10]), 60); // wants 20
		expect(res.rows.filter((r) => r.flex).map((r) => r.minutes)).toEqual([
			7, 7, 6,
		]);
		expect(res.projectedMinutes).toBe(60);
	});

	it("is byte-identical to the single-row path when only one row is marked", () => {
		const one = applyFlex(multiFixture(50, [10]), 63);
		expect(one.rows[1].minutes).toBe(13);
		expect(one.projectedMinutes).toBe(63);
		expect(one.status).toBe("exact");
	});
});

describe("flexBannerMessage (#395)", () => {
	function rowsFixture(fixed: number, flexMin: number): AgendaRow[] {
		return [
			{ who: "Fixed", detail: "", minutes: fixed, marks: null },
			{
				who: "Table Topics",
				detail: "",
				minutes: flexMin,
				marks: null,
				flex: true,
			},
		];
	}

	/** No Table Topics Master, so no `flex: true` beat exists at all (#367). */
	function noFlexRows(fixed: number): AgendaRow[] {
		return [{ who: "Fixed", detail: "", minutes: fixed, marks: null }];
	}

	it("says nothing when the agenda fits", () => {
		expect(flexBannerMessage(applyFlex(rowsFixture(50, 10), 63))).toBeNull();
	});

	it("names Table Topics when Table Topics is what is capped", () => {
		expect(flexBannerMessage(applyFlex(rowsFixture(40, 10), 90))).toBe(
			`Agenda ends 25 min early — Table Topics is at its ${TABLE_TOPICS_MAX}-min cap.`,
		);
	});

	it("names Table Topics when Table Topics is what is floored", () => {
		expect(flexBannerMessage(applyFlex(rowsFixture(58, 10), 60))).toBe(
			`Agenda runs 3 min long — Table Topics is at its ${TABLE_TOPICS_MIN}-min floor. Trim a speech or shorten the agenda.`,
		);
	});

	it("blames the meeting length, not Table Topics, when there is no flex row", () => {
		const msg = flexBannerMessage(applyFlex(noFlexRows(40), 90));
		expect(msg).toBe(
			"Agenda ends 50 min early — consider shortening the meeting length.",
		);
		expect(msg).not.toMatch(/table topics/i);
	});

	it("blames the meeting length running over too, when there is no flex row", () => {
		const msg = flexBannerMessage(applyFlex(noFlexRows(75), 60));
		expect(msg).toBe(
			"Agenda runs 15 min long — trim a speech, or increase the meeting length.",
		);
		expect(msg).not.toMatch(/table topics/i);
	});

	// The failure scenario the issue reports, end to end from real slots rather
	// than a hand-built row fixture: a skeleton crew (Toastmaster of the Day, one
	// speaker, one evaluator, NO Table Topics Master) at the default 90-minute
	// `lengthMinutes`. Since #367 that club's run sheet has no Table Topics beat
	// to resize, so the banner used to explain the shortfall in terms of a
	// segment printed nowhere on the page.
	it("does not name Table Topics on a skeleton crew's agenda that has none", () => {
		const rows = expandRunSheet([
			slot({
				id: "tm",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Schinthia",
			}),
			slot({
				id: "sp",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				assigneeName: "Rehanna",
				minMinutes: 5,
				maxMinutes: 7,
			}),
			slot({
				id: "ev",
				roleName: "Evaluator",
				category: "evaluator",
				assigneeName: "Faisal",
			}),
		]);
		// Nothing on this agenda is squishy…
		expect(rows.some((r) => r.flex === true)).toBe(false);
		expect(rows.some((r) => /table topics/i.test(r.who))).toBe(false);

		const flex = applyFlex(rows, 90);
		// …so the whole shortfall survives: a 28-minute agenda in a 90-minute
		// booking. The banner is NOT suppressed — it is the prompt that gets
		// `lengthMinutes` corrected; it just stops naming a segment the club does
		// not run.
		//
		// 28, not the 24 this asserted before #363 had the Toastmaster cover the
		// General Evaluator's role: this club runs no GE, so the Toastmaster picks
		// up "Evaluates the evaluators" (2 min) and the overall meeting evaluation
		// (2 min). Both beats are now ON the agenda, so the clock has to book them.
		expect(flex.projectedMinutes).toBe(28);
		expect(flex.status).toBe("under");
		const msg = flexBannerMessage(flex);
		expect(msg).toBe(
			"Agenda ends 62 min early — consider shortening the meeting length.",
		);
		expect(msg).not.toMatch(/table topics/i);
	});
});

describe("a club running two Table Topics Masters (#448)", () => {
	// `defaultCount` is admin-editable 0-20 on ANY role, and `addRoleSlot` adds an
	// arbitrary extra slot to one meeting, so a second Table Topics Master is
	// reachable. It was in no test fixture before this.
	const twoMasters = () => [
		slot({
			id: "tm",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			category: "leadership",
			assigneeName: "Alice",
		}),
		slot({
			id: "t1",
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
			category: "leadership",
			assigneeName: "T1",
			slotIndex: 0,
		}),
		slot({
			id: "t2",
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
			category: "leadership",
			assigneeName: "T2",
			slotIndex: 1,
		}),
		slot({
			id: "sp",
			roleKey: "speaker",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			assigneeName: "Jagpal",
		}),
	];
	const ttSegment = (rows: AgendaRow[]) =>
		rows.filter((r) => r.flex === true).reduce((n, r) => n + r.minutes, 0);

	it("marks every row the flex beat produced, not just the first", () => {
		const rows = expandRunSheet(twoMasters(), RUN_OF_SHOW);
		const flexed = rows.filter((r) => r.flex === true);
		expect(flexed).toHaveLength(2);
		expect(flexed.map((r) => r.who)).toEqual([
			"Table Topics Master · T1",
			"Table Topics Master · T2",
		]);
	});

	it("fits a short meeting instead of reporting it over by 9 minutes", () => {
		// Pre-#448: only the first row shrank, to its 5-min floor, while the second
		// held 10 — so the banner said "runs 9 min long … Table Topics is at its
		// 5-min floor" with a full 10-minute Table Topics row directly below it,
		// and named the wrong remedy ("trim a speech"). The agenda fits.
		const flex = applyFlex(expandRunSheet(twoMasters(), RUN_OF_SHOW), 30);
		expect(ttSegment(flex.rows)).toBe(6);
		expect(flex.projectedMinutes).toBe(30);
		expect(flex.deltaMinutes).toBe(0);
		expect(flexBannerMessage(flex)).toBeNull();
	});

	it("honours the segment cap instead of silently running 35 minutes of it", () => {
		// Pre-#448: the first row capped at 25 and the second held 10, so the
		// segment ran 35 against a 25-min cap while `status` read "exact" — no
		// banner at all, and the printed end time was 10 minutes optimistic.
		const flex = applyFlex(expandRunSheet(twoMasters(), RUN_OF_SHOW), 60);
		expect(ttSegment(flex.rows)).toBe(TABLE_TOPICS_MAX);
		expect(flex.status).toBe("under");
		expect(flexBannerMessage(flex)).toBe(
			"Agenda ends 11 min early — Table Topics is at its 25-min cap.",
		);
	});

	it("keeps buildTimeline's clock consistent with the resized rows", () => {
		const flex = applyFlex(expandRunSheet(twoMasters(), RUN_OF_SHOW), 30);
		const timed = buildTimeline(
			flex.rows,
			new Date("2026-07-09T18:45:00.000Z"),
			"UTC",
		);
		const last = timed[timed.length - 1];
		const end =
			timed.reduce((n, r) => n + r.minutes, 0) + 18 * 60 + 45 - last.minutes;
		expect(flex.projectedMinutes).toBe(30);
		expect(end).toBeGreaterThan(0); // clock advanced by the resized minutes
		expect(timed.filter((r) => r.flex === true).map((r) => r.minutes)).toEqual([
			3, 3,
		]);
	});
});

/** Shared by the #372 and #363 blocks below, which are two facets of the same
 *  beat: `detail.startsWith("Awards ·")` finds the row regardless of which
 *  roles the club runs (#372) or who holds the Toastmaster of the Day slot
 *  (#363). Relies on the `expandRunSheet` default (`RUN_OF_SHOW`), same as
 *  every other beat-behavior test in this file. */
const awardsRow = (slots: AgendaSlot[]): AgendaRow | undefined =>
	expandRunSheet(slots).find((r) => r.detail.startsWith("Awards ·"));

describe("expandRunSheet — awards beat adapts to the scored segments (#372)", () => {
	const speaker = slot({
		id: "sp",
		roleName: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		assigneeName: "S",
	});
	const ttm = slot({
		id: "tt",
		roleName: "Table Topics Master",
		category: "leadership",
		assigneeName: "M",
	});
	const evaluator = slot({
		id: "ev",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "E",
	});

	it("lists every category when the club runs all three scored segments", () => {
		expect(awardsRow([speaker, ttm, evaluator])?.detail).toBe(
			"Awards · Best Table Topic, Best Evaluator & Best Speaker · hands over to the President",
		);
	});

	it("omits Best Table Topic for a club with no Table Topics Master", () => {
		expect(awardsRow([speaker, evaluator])?.detail).toBe(
			"Awards · Best Evaluator & Best Speaker · hands over to the President",
		);
	});

	it("names a single category without a conjunction", () => {
		expect(awardsRow([speaker])?.detail).toBe(
			"Awards · Best Speaker · hands over to the President",
		);
	});

	it("omits the beat entirely when the club scores nothing", () => {
		expect(awardsRow([])).toBeUndefined();
	});

	it("uses the fixed award labels, not the club's own role names", () => {
		const renamed = slot({
			id: "tt",
			roleKey: "table_topics_master",
			roleName: "Topics Chief",
			category: "leadership",
			assigneeName: "M",
		});
		expect(awardsRow([renamed])?.detail).toBe(
			"Awards · Best Table Topic · hands over to the President",
		);
	});
});

describe("awards beat is role-bound (#363)", () => {
	it("names the Toastmaster who presents them", () => {
		const slots = [
			slot({
				id: "tm",
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
			slot({
				id: "sp",
				roleKey: "speaker",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			}),
		];
		expect(awardsRow(slots)?.who).toBe("Toastmaster of the Day · Faisal");
	});

	it("binds by key through a club rename, and labels the row with the CLUB's name", () => {
		const slots = [
			slot({
				id: "tm",
				roleKey: "toastmaster_of_the_day",
				roleName: "Master of Ceremonies",
				category: "leadership",
				assigneeName: "Faisal",
			}),
			slot({
				id: "sp",
				roleKey: "speaker",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			}),
		];
		// The beat still FINDS the renamed slot (#368 — binding is by key), so the
		// awards row exists and names its holder. It now also LABELS it the way the
		// club does (#445): `expandRunSheet` reads the matched slot's `roleName`,
		// the same source the header legend and `ROLES_TOKEN` always read. The
		// inconsistency this test was written to pin is closed, and inverting it is
		// the deliberate change its old comment asked for.
		expect(awardsRow(slots)?.who).toBe("Master of Ceremonies · Faisal");
	});

	it("still hands out awards at a club with no Toastmaster of the Day", () => {
		const slots = [
			slot({
				id: "sp",
				roleKey: "speaker",
				roleName: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			}),
		];
		expect(awardsRow(slots)?.who).toBe("Toastmaster of the Day");
	});
});

describe("BeatFallback — owner and detail swap (#363)", () => {
	const TM = {
		roleKey: "toastmaster_of_the_day",
		roleName: "Toastmaster of the Day",
	};
	const TTM = {
		roleKey: "table_topics_master",
		roleName: "Table Topics Master",
	};

	const beat: Beat = {
		kind: "role",
		...TTM,
		role: "plain",
		detail: "Introduces the General Evaluator",
		minutes: 0,
		fallbacks: [{ unless: TTM, owner: TM }],
	};

	it("keeps the beat's own owner when the `unless` role has a slot", () => {
		const slots = [
			slot({
				roleKey: "table_topics_master",
				roleName: "Table Topics Master",
				category: "leadership",
				assigneeName: "Rasheed",
			}),
		];
		expect(expandRunSheet(slots, [beat])).toEqual([
			{
				who: "Table Topics Master · Rasheed",
				roleKey: "table_topics_master",
				detail: "Introduces the General Evaluator",
				minutes: 0,
				marks: null,
			},
		]);
	});

	it("swaps to the fallback owner when the `unless` role has no slot", () => {
		const slots = [
			slot({
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
		];
		expect(expandRunSheet(slots, [beat])).toEqual([
			{
				who: "Toastmaster of the Day · Faisal",
				roleKey: "toastmaster_of_the_day",
				detail: "Introduces the General Evaluator",
				minutes: 0,
				marks: null,
			},
		]);
	});

	it("swaps only the detail when the fallback names no owner", () => {
		const withDetail: Beat = {
			...beat,
			fallbacks: [
				{
					unless: { roleKey: "timer", roleName: "Timer" },
					detail: "Opens voting for Best Speaker",
				},
			],
		};
		const slots = [
			slot({
				roleKey: "table_topics_master",
				roleName: "Table Topics Master",
				category: "leadership",
				assigneeName: "Rasheed",
			}),
		];
		expect(expandRunSheet(slots, [withDetail])[0]).toMatchObject({
			who: "Table Topics Master · Rasheed",
			detail: "Opens voting for Best Speaker",
		});
	});

	it("omits the beat when neither the owner nor the fallback owner has a slot", () => {
		expect(expandRunSheet([], [beat])).toEqual([]);
	});

	it("swaps both owner and detail when the fallback names both", () => {
		const both: Beat = {
			...beat,
			fallbacks: [
				{
					unless: TTM,
					owner: TM,
					detail: "Hands off directly to the General Evaluator",
				},
			],
		};
		const slots = [
			slot({
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
		];
		expect(expandRunSheet(slots, [both])).toEqual([
			{
				who: "Toastmaster of the Day · Faisal",
				roleKey: "toastmaster_of_the_day",
				detail: "Hands off directly to the General Evaluator",
				minutes: 0,
				marks: null,
			},
		]);
	});

	// `fallbacks` moved onto the SHARED half of `Beat` (#363), so an event beat
	// carries them too and `expandRunSheet` resolves the owner once for both
	// arms. The event arm reads that owner as `who`, and only its `detail` half
	// had coverage — which is the half that cannot drift, since both arms share
	// one `beatDetail`. This is the arm-specific line: `fallbackOwner?.roleName
	// ?? beat.who`, the thing the old event-only `fallback` did with a bare
	// string that named a role which did not exist.
	it("replaces an event beat's `who` with the fallback owner's role name", () => {
		const SAA = { roleKey: "sergeant_at_arms", roleName: "Sergeant-at-Arms" };
		const event: Beat = {
			kind: "event",
			who: "Sergeant-at-Arms",
			detail: "Call to Order · phones silent · introduces the President",
			minutes: 1,
			fallbacks: [
				{ unless: SAA, owner: { roleKey: "president", roleName: "President" } },
			],
		};
		// No Sergeant-at-Arms slot ⇒ the fallback fires and the President calls
		// the room to order instead.
		expect(expandRunSheet([], [event])[0]).toMatchObject({
			who: "President",
			detail: "Call to Order · phones silent · introduces the President",
		});
		// …and the beat's own `who` survives when the role IS run. An event beat
		// is not slot-bound, so it never gains a "· Name" the way a role row does.
		const saa = slot({
			roleKey: "sergeant_at_arms",
			roleName: "Sergeant-at-Arms",
			category: "leadership",
			assigneeName: "Bilal",
		});
		expect(expandRunSheet([saa], [event])[0]).toMatchObject({
			who: "Sergeant-at-Arms",
		});
	});

	it("a degenerate fallback (`unless` only, no owner or detail) changes nothing when it fires", () => {
		const noOp: Beat = {
			...beat,
			fallbacks: [{ unless: { roleKey: "timer", roleName: "Timer" } }],
		};
		const slots = [
			slot({
				roleKey: "table_topics_master",
				roleName: "Table Topics Master",
				category: "leadership",
				assigneeName: "Rasheed",
			}),
		];
		// No Timer slot ⇒ the fallback fires, but names neither a replacement
		// owner nor detail, so the row is identical to a beat with no fallback.
		expect(expandRunSheet(slots, [noOp])).toEqual([
			{
				who: "Table Topics Master · Rasheed",
				roleKey: "table_topics_master",
				detail: "Introduces the General Evaluator",
				minutes: 0,
				marks: null,
			},
		]);
	});
});

/**
 * `fallbacks` is a LIST because one beat can need two independent answers
 * (#363): the Best-Evaluator vote drops its timer's-report clause when the club
 * runs no Timer AND moves to the Toastmaster when it runs no General Evaluator.
 * A singular fallback could only ever answer one, and the one it answered was
 * the Timer's — which is why that row used to print the bare, unheld role name.
 *
 * The mechanics are pinned here on synthetic beats; the real template's use of
 * them is pinned by the no-GE suites above.
 */
describe("BeatFallback — plural, per-field resolution (#363)", () => {
	const TM = {
		roleKey: "toastmaster_of_the_day",
		roleName: "Toastmaster of the Day",
	};
	const GE = { roleKey: "general_evaluator", roleName: "General Evaluator" };
	const TIMER = { roleKey: "timer", roleName: "Timer" };

	/** A miniature of the Best-Evaluator vote beat: one entry rewrites the copy,
	 *  the other relocates the owner, and they trigger on different roles. */
	const twoFallbacks: Beat = {
		kind: "role",
		...GE,
		role: "plain",
		detail: "Calls for the Timer's report · opens voting for Best Evaluator",
		minutes: 1,
		fallbacks: [
			{ unless: TIMER, detail: "Opens voting for Best Evaluator" },
			{ unless: GE, owner: TM },
		],
	};

	const tm = slot({
		id: "tm",
		roleKey: "toastmaster_of_the_day",
		roleName: "Toastmaster of the Day",
		category: "leadership",
		assigneeName: "Faisal",
	});
	const ge = slot({
		id: "ge",
		roleKey: "general_evaluator",
		roleName: "General Evaluator",
		category: "leadership",
		assigneeName: "Riyaz",
	});
	const timer = slot({
		id: "ti",
		roleKey: "timer",
		roleName: "Timer",
		category: "functionary",
		assigneeName: "Muhammad",
	});

	it("applies neither entry when both `unless` roles have slots", () => {
		expect(expandRunSheet([tm, ge, timer], [twoFallbacks])[0]).toMatchObject({
			who: "General Evaluator · Riyaz",
			detail: "Calls for the Timer's report · opens voting for Best Evaluator",
		});
	});

	it("applies only the entry whose `unless` role is missing — the Timer's", () => {
		expect(expandRunSheet([tm, ge], [twoFallbacks])[0]).toMatchObject({
			who: "General Evaluator · Riyaz",
			detail: "Opens voting for Best Evaluator",
		});
	});

	it("applies only the entry whose `unless` role is missing — the GE's", () => {
		expect(expandRunSheet([tm, timer], [twoFallbacks])[0]).toMatchObject({
			who: "Toastmaster of the Day · Faisal",
			detail: "Calls for the Timer's report · opens voting for Best Evaluator",
		});
	});

	it("applies BOTH when both `unless` roles are missing — the case a singular fallback could not express", () => {
		expect(expandRunSheet([tm], [twoFallbacks])[0]).toMatchObject({
			who: "Toastmaster of the Day · Faisal",
			detail: "Opens voting for Best Evaluator",
		});
	});

	it("resolves per FIELD, so a later detail-only entry keeps an earlier entry's owner", () => {
		// The ordering hazard a naive "last fired entry wins" would hit: entry 2
		// names no owner, so entry 1's must survive it.
		const detailAfterOwner: Beat = {
			...twoFallbacks,
			fallbacks: [
				{ unless: GE, owner: TM },
				{ unless: TIMER, detail: "Opens voting for Best Evaluator" },
			],
		};
		expect(expandRunSheet([tm], [detailAfterOwner])[0]).toMatchObject({
			who: "Toastmaster of the Day · Faisal",
			detail: "Opens voting for Best Evaluator",
		});
	});

	it("lets a later entry win when two fired entries set the SAME field", () => {
		// Owned by the Toastmaster, so the row survives with no GE slot: this test
		// is about which detail wins, not about owner relocation.
		const clashing: Beat = {
			...twoFallbacks,
			...TM,
			fallbacks: [
				{ unless: TIMER, detail: "First" },
				{ unless: GE, detail: "Second" },
			],
		};
		expect(expandRunSheet([tm], [clashing])[0]).toMatchObject({
			detail: "Second",
		});
	});
});

describe("renderUnowned (#363)", () => {
	it("renders the bare role name when the owning role has no slot", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Opens voting for Best Speaker",
			minutes: 1,
			renderUnowned: true,
		};
		expect(expandRunSheet([], [beat])).toEqual([
			{
				who: "Toastmaster of the Day",
				roleKey: "toastmaster_of_the_day",
				detail: "Opens voting for Best Speaker",
				minutes: 1,
				marks: null,
			},
		]);
	});

	it("still prefers the assignee when the role IS held", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Opens voting for Best Speaker",
			minutes: 1,
			renderUnowned: true,
		};
		const slots = [
			slot({
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
		];
		expect(expandRunSheet(slots, [beat])[0].who).toBe(
			"Toastmaster of the Day · Faisal",
		);
	});

	it("omits an unowned beat WITHOUT the flag — the existing default is unchanged", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Opens meeting",
			minutes: 3,
		};
		expect(expandRunSheet([], [beat])).toEqual([]);
	});

	it("requiresAnyOf still gates the beat even with renderUnowned set — the combination Task 2 puts on the vote beats", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Opens voting for Best Speaker",
			minutes: 1,
			renderUnowned: true,
			requiresAnyOf: [{ roleKey: "speaker", roleName: "Speaker" }],
		};
		const slots = [
			slot({
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
		];
		// The Toastmaster IS held, so a bug that let renderUnowned bypass the
		// gate would print a row here — but requiresAnyOf (no Speaker slot) must
		// still win, exactly as it does on the vote beats Task 2 stacks this onto.
		expect(expandRunSheet(slots, [beat])).toEqual([]);
	});
});

describe("BeatFallback — fb.detail resolves through resolveDetail (#363)", () => {
	// A fallback's `detail` isn't a fixed literal — it can carry ROLES_TOKEN
	// just like a beat's own detail can — so it must go through the same
	// resolution the beat's own detail does, not get substituted verbatim.

	it("resolves ROLES_TOKEN in the fallback detail on a role beat", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
			role: "plain",
			detail: "Own detail, unused once the fallback fires",
			minutes: 1,
			requiresAnyOf: [{ roleKey: "timer", roleName: "Timer" }],
			fallbacks: [
				{
					unless: {
						roleKey: "table_topics_master",
						roleName: "Table Topics Master",
					},
					owner: {
						roleKey: "toastmaster_of_the_day",
						roleName: "Toastmaster of the Day",
					},
					detail: `Introduces the ${ROLES_TOKEN}`,
				},
			],
		};
		const slots = [
			slot({
				roleKey: "timer",
				roleName: "Timer",
				category: "functionary",
				assigneeName: "T",
			}),
			slot({
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
				category: "leadership",
				assigneeName: "Faisal",
			}),
		];
		// No Table Topics Master slot ⇒ the fallback fires; ROLES_TOKEN must
		// resolve against the beat's own requiresAnyOf (the Timer slot), not
		// print literally.
		expect(expandRunSheet(slots, [beat])).toEqual([
			{
				who: "Toastmaster of the Day · Faisal",
				roleKey: "toastmaster_of_the_day",
				detail: "Introduces the Timer",
				minutes: 1,
				marks: null,
			},
		]);
	});

	it("resolves ROLES_TOKEN in the fallback detail on an event beat", () => {
		const beat: Beat = {
			kind: "event",
			who: "Timer",
			detail: "Own detail, unused once the fallback fires",
			minutes: 1,
			requiresAnyOf: [{ roleKey: "grammarian", roleName: "Grammarian" }],
			fallbacks: [
				{
					unless: { roleKey: "timer", roleName: "Timer" },
					detail: `Introduces the ${ROLES_TOKEN}`,
				},
			],
		};
		const slots = [
			slot({
				roleKey: "grammarian",
				roleName: "Grammarian",
				category: "functionary",
				assigneeName: "G",
			}),
		];
		// No Timer slot ⇒ the fallback fires; ROLES_TOKEN resolves against the
		// beat's own requiresAnyOf (the Grammarian slot).
		expect(expandRunSheet(slots, [beat])).toEqual([
			{
				who: "Timer",
				detail: "Introduces the Grammarian",
				minutes: 1,
				marks: null,
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// #508 — the three cues the agenda was missing. All from the 2026-08-01 meeting:
// the page knew the order but not always what to SAY, which is what a
// first-timer holding it needs.
//
// Items 1 and 5 of that issue are NOT here: they need evaluator→speaker pairing,
// which nothing in the app can set (#512), so "Evaluate {speaker}" would have
// been copy over a column that is always null.
// ---------------------------------------------------------------------------
describe("meeting-script cues (#508)", () => {
	const grammarian = (over: Partial<AgendaSlot> = {}) =>
		slot({
			id: "gr",
			roleKey: "grammarian",
			roleName: "Grammarian",
			category: "functionary",
			assigneeName: "Gina",
			...over,
		});

	/** The functionary-intro row — identified by the clause only it carries. */
	const introDetail = (slots: AgendaSlot[]) =>
		expandRunSheet(slots).find((r) =>
			r.detail.includes("; each explains their role"),
		)?.detail;

	const tableTopicsDetail = (slots: AgendaSlot[]) =>
		expandRunSheet(slots).find((r) => r.detail.startsWith("Impromptu topics"))
			?.detail;

	const evalTimingRow = (
		slots: AgendaSlot[],
		geIntroducesFunctionaries = false,
	) =>
		expandRunSheet(slots, buildRunOfShow({ geIntroducesFunctionaries })).find(
			(r) => r.detail.includes("timing for an evaluation"),
		);

	describe("the Grammarian's Word of the Day is cued where it happens", () => {
		it("names it on the functionary intro when the club runs a Grammarian", () => {
			expect(introDetail([...sixRoleClub(), grammarian()])).toBe(
				"Introduces the Timer & Grammarian; each explains their role · the Grammarian gives the Word of the Day",
			);
		});

		it("drops the cue but KEEPS the row for a club with functionaries and no Grammarian", () => {
			// sixRoleClub runs a Timer, so the intro still has someone to introduce.
			// The row surviving is the point: the `unless` fallback replaces the
			// detail, it does not gate the beat.
			const detail = introDetail(sixRoleClub());
			expect(detail).toBe("Introduces the Timer; each explains their role");
			expect(detail).not.toContain("Word of the Day");
		});

		it("uses the club's OWN name for the role in the cue, not ours", () => {
			// The cue and the list it follows must agree: a club that renamed
			// Grammarian would otherwise read "Introduces the Wordsmith … the
			// Grammarian gives the Word of the Day" — one row contradicting itself.
			expect(
				introDetail([
					...sixRoleClub(),
					grammarian({ roleName: "Wordsmith", assigneeName: "Gina" }),
				]),
			).toBe(
				"Introduces the Timer & Wordsmith; each explains their role · the Wordsmith gives the Word of the Day",
			);
		});

		// Found in review. The cue and the {roles} list it follows must answer the
		// SAME question. They did not: the list is the club's `functionaries`
		// CATEGORY, while a plain `unless` is `hasRole` — key/name, category-blind.
		// An admin can move a standard role out of its category
		// (`applyRoleDefinitionUpdate`; `agenda-parity.test.ts` already carries that
		// shape for the Timer), and the row then introduced only the Timer while
		// still cueing a Grammarian it had just declined to introduce.
		it("drops the cue for a Grammarian recategorised OUT of the functionaries", () => {
			const detail = introDetail([
				...sixRoleClub(),
				grammarian({ category: "leadership" }),
			]);
			// The row is unchanged from a club with no Grammarian at all, which is
			// the point: this club runs no Grammarian *as a functionary*.
			expect(detail).toBe("Introduces the Timer; each explains their role");
			expect(detail).not.toContain("Word of the Day");
		});

		// The other side of the same gate: a Grammarian INSIDE the group still
		// earns the cue. Without this, scoping the fallback to the group could be
		// over-tightened to "never fire" and the test above would not notice.
		it("keeps the cue for a Grammarian inside the functionaries", () => {
			expect(introDetail([...sixRoleClub(), grammarian()])).toContain(
				"the Grammarian gives the Word of the Day",
			);
		});
	});

	describe("the Timer explains Table Topics timing as the segment opens", () => {
		it("asks the Timer on the Table Topics row", () => {
			expect(tableTopicsDetail(sixRoleClub())).toBe(
				"Impromptu topics using the Word of the Day · asks the Timer to explain the timing",
			);
		});

		it("drops the cue but KEEPS the segment for a club with no Timer", () => {
			const noTimer = sixRoleClub().filter((s) => s.roleKey !== "timer");
			expect(tableTopicsDetail(noTimer)).toBe(
				"Impromptu topics using the Word of the Day",
			);
		});

		it("is carried by the Table Topics Master, who owns the segment", () => {
			const row = expandRunSheet(sixRoleClub()).find((r) =>
				r.detail.startsWith("Impromptu topics"),
			);
			expect(row?.who).toBe("Table Topics Master · Rasheed");
		});
	});

	describe("the Timer explains evaluation timing before the evaluations", () => {
		it("is asked by the General Evaluator", () => {
			expect(evalTimingRow(sixRoleClub())).toMatchObject({
				who: "General Evaluator · Riyaz",
				detail: "Asks the Timer to explain the timing for an evaluation",
			});
		});

		it("falls to the Toastmaster at a club with no General Evaluator", () => {
			const noGe = sixRoleClub().filter(
				(s) => s.roleKey !== "general_evaluator",
			);
			expect(evalTimingRow(noGe)?.who).toBe("Toastmaster of the Day · Faisal");
		});

		// The two halves of `alsoRequiresAnyOf`. Each asserts the row is ABSENT for
		// a club missing one of the pair, which is the only observable the gate has
		// — and each fails if its half of the AND is dropped.
		it("is omitted for a club with evaluators but no Timer", () => {
			const noTimer = sixRoleClub().filter((s) => s.roleKey !== "timer");
			expect(evalTimingRow(noTimer)).toBeUndefined();
		});

		it("is omitted for a club with a Timer but no evaluators", () => {
			const noEvaluators = sixRoleClub().filter(
				(s) => s.roleKey !== "evaluator",
			);
			expect(evalTimingRow(noEvaluators)).toBeUndefined();
		});

		// Position is the whole point: the room needs the constraint BEFORE the
		// first evaluator stands up. A cue that lands after them is decoration.
		it("sits after the evaluators hand-off and before the first evaluation", () => {
			const details = expandRunSheet(sixRoleClub()).map((r) => r.detail);
			const handoff = details.findIndex((d) =>
				d.startsWith("Introduces the speech evaluators"),
			);
			const cue = details.indexOf(
				"Asks the Timer to explain the timing for an evaluation",
			);
			const firstEvaluation = details.findIndex((d) =>
				d.startsWith("Evaluates a speaker"),
			);
			expect(handoff).toBeGreaterThanOrEqual(0);
			expect(cue).toBe(handoff + 1);
			expect(cue).toBeLessThan(firstEvaluation);
		});

		it("appears in both club variants, since neither changes the evaluation segment", () => {
			for (const mcf of [false, true]) {
				expect(evalTimingRow(sixRoleClub(), mcf)).toBeDefined();
			}
		});
	});
});

// ---------------------------------------------------------------------------
// The two GATE MECHANISMS #508 added, exercised as mechanisms rather than
// through their single production caller.
//
// Both were invisible to the suite that shipped them, and a mutation run proved
// it: the only beat setting `alsoRequiresAnyOf` passes a ONE-element list, so
// swapping `.some` for `.every` changed nothing; and the only fallback setting
// `withinGroup` also declares a `requiresGroup`, so deleting the
// `beat.requiresGroup != null` guard — which makes the lookup crash on a beat
// without one — also changed nothing. Both mutants passed all 644 tests.
//
// These use hand-built beats deliberately. The production template cannot
// express either case, so testing through it is not an option, and a generic
// mechanism whose contract is stated in its doc comment should be pinned at the
// mechanism.
// ---------------------------------------------------------------------------
describe("Beat.alsoRequiresAnyOf — ANY within the list, ALL against the gate", () => {
	/** A beat needing an evaluator (base gate) AND someone to keep time, where
	 *  the club may staff that second job under either of two roles. */
	const beat: Beat = {
		kind: "event",
		who: "General Evaluator",
		detail: "Asks for the timing",
		minutes: 1,
		requiresAnyOf: [{ roleKey: "evaluator", roleName: "Evaluator" }],
		alsoRequiresAnyOf: [
			{ roleKey: "timer", roleName: "Timer" },
			{ roleKey: "grammarian", roleName: "Grammarian" },
		],
	};
	const evaluator = slot({
		id: "ev",
		roleKey: "evaluator",
		roleName: "Evaluator",
		category: "evaluator",
		assigneeName: "Sudheer",
	});
	const timer = slot({
		id: "ti",
		roleKey: "timer",
		roleName: "Timer",
		category: "functionary",
		assigneeName: "Muhammad",
	});
	const grammarian = slot({
		id: "gr",
		roleKey: "grammarian",
		roleName: "Grammarian",
		category: "functionary",
		assigneeName: "Gina",
	});

	// The ANY-of half. Each of these fails if the list is read as ALL-of, which
	// is exactly the mutant the production one-element caller cannot catch.
	it("renders when only the FIRST role of the list is present", () => {
		expect(expandRunSheet([evaluator, timer], [beat])).toHaveLength(1);
	});

	it("renders when only the SECOND role of the list is present", () => {
		expect(expandRunSheet([evaluator, grammarian], [beat])).toHaveLength(1);
	});

	// The ALL-of half: the list ANDs with the beat's own gate, so losing either
	// side drops the row.
	it("is dropped when the base gate is met but NO role in the list is", () => {
		expect(expandRunSheet([evaluator], [beat])).toEqual([]);
	});

	it("is dropped when a role in the list is present but the base gate is not", () => {
		expect(expandRunSheet([timer], [beat])).toEqual([]);
	});
});

describe("BeatFallback.withinGroup — ignored on a beat that declares no group", () => {
	/** The documented carve-out: "Ignored when the beat declares no
	 *  `requiresGroup`, since there is no group to look inside." A beat setting
	 *  `withinGroup` without a group must fall back to the roster-wide `hasRole`
	 *  — not consult a group that does not exist. */
	const beat: Beat = {
		kind: "event",
		who: "Toastmaster of the Day",
		detail: "Introduces the functionaries · the Grammarian gives the word",
		minutes: 3,
		fallbacks: [
			{
				unless: { roleKey: "grammarian", roleName: "Grammarian" },
				withinGroup: true,
				detail: "Introduces the functionaries",
			},
		],
	};

	it("keeps the clause for a Grammarian OUTSIDE any functionary group", () => {
		// Category-blind on purpose: with no group to scope to, `withinGroup` has
		// nothing to mean, so this resolves through `hasRole` and the Grammarian
		// counts wherever the admin filed them. Deleting the
		// `beat.requiresGroup != null` guard makes this throw instead.
		const rows = expandRunSheet(
			[
				slot({
					id: "gr",
					roleKey: "grammarian",
					roleName: "Grammarian",
					category: "leadership",
					assigneeName: "Gina",
				}),
			],
			[beat],
		);
		expect(rows[0]?.detail).toBe(
			"Introduces the functionaries · the Grammarian gives the word",
		);
	});

	it("still fires the fallback when the club runs no Grammarian at all", () => {
		const rows = expandRunSheet(
			[
				slot({
					id: "ti",
					roleKey: "timer",
					roleName: "Timer",
					category: "functionary",
					assigneeName: "Muhammad",
				}),
			],
			[beat],
		);
		expect(rows[0]?.detail).toBe("Introduces the functionaries");
	});
});

/**
 * `{names:…}` — the people a hand-off row introduces (#585).
 *
 * Tested through the Table Topics Master hand-off, a SINGULAR target. The two
 * group hand-offs (speakers, speech evaluators) deliberately name nobody: their
 * members' own rows are the very next thing on the page, so the names duplicated
 * the line beneath at the cost of shrinking the whole sheet. See the speakers
 * beat in `buildRunOfShow`.
 *
 * Each property below is a live bug if reversed, and none was visible to any
 * other test in this file — all were found by mutating the source and watching
 * the whole suite stay green.
 */
describe("hand-off rows name the people they introduce (#585)", () => {
	const totd = slot({
		id: "tm",
		roleKey: "toastmaster_of_the_day",
		roleName: "Toastmaster of the Day",
		category: "leadership",
		assigneeName: "Faisal",
	});
	const ttmRow = (over: Partial<AgendaSlot>) =>
		slot({
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
			category: "leadership",
			...over,
		});
	const handoffFor = (rows: AgendaRow[], prefix: string) =>
		rows.find((r) => r.detail.startsWith(prefix));
	const introduced = (slots: AgendaSlot[]) =>
		handoffFor(expandRunSheet(slots), "Introduces the Table Topics Master")
			?.detail;

	it("names them", () => {
		expect(
			introduced([totd, ttmRow({ id: "ttm", assigneeName: "Rasheed" })]),
		).toBe("Introduces the Table Topics Master: Rasheed");
	});

	/**
	 * An UNASSIGNED target contributes nobody, degrading to the pre-#585 copy.
	 *
	 * `assigneeDisplay` would have given `OPEN_LABEL` here, which is right in the
	 * `who` column (an unclaimed role still has to be announced as unclaimed) and
	 * wrong in a list of people to introduce: every hand-off at a club with open
	 * slots would have read "Introduces the Table Topics Master: — open —".
	 */
	it("names nobody when the target role is unassigned, leaving no dangling separator", () => {
		const detail = introduced([
			totd,
			ttmRow({ id: "ttm", assigneeName: null }),
		]);
		expect(detail).toBe("Introduces the Table Topics Master");
		expect(detail).not.toContain(OPEN_LABEL);
		expect(detail).not.toContain(":");
	});

	/**
	 * An EMPTY-STRING assignee is `!= null` but has no display name, so a caller
	 * that filtered on the field rather than on the rendered name would show
	 * "— open —" on one surface and nothing on the other. `introducedNames`
	 * exists as a shared helper largely to make that one rule.
	 */
	it("treats an empty-string assignee as nobody, not as an open slot", () => {
		expect(introduced([totd, ttmRow({ id: "ttm", assigneeName: "" })])).toBe(
			"Introduces the Table Topics Master",
		);
	});

	/**
	 * The guest marker survives, deliberately: a hand-off is the moment the room
	 * is being told who someone IS, and "· Guest" is the part the Toastmaster
	 * most needs (#151).
	 */
	it("keeps the guest marker on an introduced name", () => {
		expect(
			introduced([
				totd,
				ttmRow({ id: "ttm", assigneeName: "Alice", assigneeIsGuest: true }),
			]),
		).toBe("Introduces the Table Topics Master: Alice · Guest");
	});

	/** Two holders of one nameable role — rare, but the only case where the sort
	 *  inside `introducedNames` is observable. Supplied out of slot order. */
	it("lists multiple holders in slot order, not array order", () => {
		expect(
			introduced([
				totd,
				ttmRow({ id: "b", slotIndex: 1, assigneeName: "Bob" }),
				ttmRow({ id: "a", slotIndex: 0, assigneeName: "Alice" }),
			]),
		).toBe("Introduces the Table Topics Master: Alice & Bob");
	});

	/**
	 * The two GROUP hand-offs name nobody, by design. Asserted rather than left
	 * implicit: this is the decision the measurement in `print-density.test.ts`
	 * paid for, and re-adding `namesToken` to either beat is a one-token change
	 * that would otherwise land silently.
	 */
	it("leaves the group hand-offs naming nobody — their members' own rows follow", () => {
		const rows = expandRunSheet(sixRoleClub());
		expect(handoffFor(rows, "Introduces the speakers")?.detail).toBe(
			"Introduces the speakers",
		);
		expect(handoffFor(rows, "Introduces the speech evaluators")?.detail).toBe(
			"Introduces the speech evaluators",
		);
		// …and the rows they hand to DO name those people, which is the reason.
		expect(rows.some((r) => r.who === "Speaker · Jagpal")).toBe(true);
		expect(rows.some((r) => r.who === "Evaluator · Sudheer")).toBe(true);
	});

	/**
	 * An unrecognised key stays VERBATIM, mirroring `{role:tymer}` (#445): a typo
	 * has to show up on the page rather than silently dropping the cue. Reached
	 * through a hand-written beat, since no shipped beat has one.
	 */
	it("leaves an unrecognised {names:…} key verbatim rather than blanking it", () => {
		const typo: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Introduces the speakers{names:speeker}",
			minutes: 1,
		};
		expect(expandRunSheet([totd], [typo])[0].detail).toBe(
			"Introduces the speakers{names:speeker}",
		);
	});

	/**
	 * The hostile-input axis `{names:…}` newly opened. `roleName` already had two
	 * guards because an admin types it; `assigneeName` is the same class or worse
	 * — a guest row can be minted from the PUBLIC ballot-join with only a trim,
	 * then assigned to a slot, and it now flows into a printed row through the
	 * same `String.replace`. The replacer is a FUNCTION, so `$&` is inert and one
	 * pass never rescans its own output; nothing pinned either for this input.
	 */
	it("substitutes an assignee name containing $-sequences or a token literally", () => {
		for (const hostile of [
			"Riyaz $& $` $' Ali",
			"{names:speaker}",
			"{awards}",
		]) {
			const detail = introduced([
				totd,
				ttmRow({ id: "ttm", assigneeName: hostile }),
			]);
			expect(detail).toBe(`Introduces the Table Topics Master: ${hostile}`);
			// The tells: no spliced surrounding copy, no second expansion.
			expect(detail).not.toContain("Best Table Topic,");
			expect(detail).not.toContain(": Introduces");
		}
	});
});
