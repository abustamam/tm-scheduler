import { describe, expect, it } from "vitest";
import type { AgendaRow, AgendaSlot, Beat } from "./agenda-runsheet";
import {
	AWARDS_TOKEN,
	applyFlex,
	beatDuration,
	buildLegend,
	buildReportingLegend,
	buildRunOfShow,
	expandRunSheet,
	FLEX_TOLERANCE_MINUTES,
	flexBannerMessage,
	formatBeatMinutes,
	functionarySlots,
	hasAnyFunctionaryRole,
	hasAnyReportingFunctionaryRole,
	ROLES_TOKEN,
	RUN_OF_SHOW,
	reportingFunctionarySlots,
	TABLE_TOPICS_MAX,
	TABLE_TOPICS_MIN,
} from "./agenda-runsheet";

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

describe("buildRunOfShow", () => {
	it("returns 16 ordered beats for the corrected default (non-MCF) variant", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		expect(beats).toHaveLength(16);
	});

	it("every beat has a positive duration", () => {
		for (const geIntroducesFunctionaries of [false, true]) {
			for (const beat of buildRunOfShow({ geIntroducesFunctionaries })) {
				expect(beat.minutes).toBeGreaterThan(0);
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

	it("beat 4 (functionary intro) is owned by the Toastmaster of the Day by default", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		const beat4 = beats[3];
		expect(beat4.kind).toBe("role");
		expect((beat4 as { roleKey: string }).roleKey).toBe(
			"toastmaster_of_the_day",
		);
		// The detail names the club's own functionaries at expansion time (#367),
		// so the beat carries the token rather than a fixed "the functionaries".
		expect(beat4.detail).toBe(
			`Introduces the ${ROLES_TOKEN}; each explains their role`,
		);
	});

	it("beat 4 is owned by the General Evaluator when geIntroducesFunctionaries is true (MCF)", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: true });
		const beat4 = beats[3];
		expect(beat4.kind).toBe("role");
		expect((beat4 as { roleKey: string }).roleKey).toBe("general_evaluator");
		expect(beat4.detail).toBe(
			`Introduces the ${ROLES_TOKEN}; each explains their role`,
		);
	});

	it("gates each vote beat on the segment it belongs to", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		const gateOf = (detail: string) =>
			beats
				.find((b) => b.detail === detail)
				?.requiresAnyOf?.map((r) => r.roleKey);
		expect(gateOf("Timer's report · vote Best Speaker")).toEqual(["speaker"]);
		expect(gateOf("Timer's report · vote Best Table Topics")).toEqual([
			"table_topics_master",
		]);
		expect(gateOf("Timer's report · vote Best Evaluator")).toEqual([
			"evaluator",
		]);
	});

	it("the MCF variant differs from the default ONLY in beat 4's owner and the handback that follows it", () => {
		const withoutGe = buildRunOfShow({ geIntroducesFunctionaries: false });
		const withGe = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(withGe).toHaveLength(withoutGe.length + 1);
		// Beat 4 changes owner, beat 5 is the handback the swap makes necessary.
		expect(withGe[3]).not.toEqual(withoutGe[3]);
		// Every other beat is the default template's, in the default order.
		expect(withGe.filter((_, i) => i !== 3 && i !== 4)).toEqual(
			withoutGe.filter((_, i) => i !== 3),
		);
	});

	it("MCF hands the room back to the Toastmaster before the speeches, in a row of its own", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(beats[4]).toMatchObject({
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Introduces the speakers",
		});
		// Gated on the speakers it promises, not on the functionaries whose intro
		// put the General Evaluator in front of them.
		expect(beats[4].requiresAnyOf?.map((r) => r.roleKey)).toEqual(["speaker"]);
		expect(beats[4].requiresGroup).toBeUndefined();
		// Directly after the GE's intro and directly before the prepared speeches.
		expect(beats[3].detail).toBe(
			`Introduces the ${ROLES_TOKEN}; each explains their role`,
		);
		expect(beats[5]).toMatchObject({ detail: "Prepared speech" });
	});

	it("the default variant has no handback beat — the Toastmaster never gave the room away", () => {
		const beats = buildRunOfShow({ geIntroducesFunctionaries: false });
		expect(beats.some((b) => b.detail === "Introduces the speakers")).toBe(
			false,
		);
	});

	it("beats 11–13 (the GE closing sequence) are identical across both variants", () => {
		const withoutGe = buildRunOfShow({ geIntroducesFunctionaries: false });
		const withGe = buildRunOfShow({ geIntroducesFunctionaries: true });
		// The MCF variant carries one extra beat before them (the handback), so
		// the sequence is located by its content rather than a shared index.
		for (const i of [10, 11, 12]) {
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
			// Directly after the awards, and directly before the closing.
			expect(beats[beats.length - 3].detail).toBe(`Awards · ${AWARDS_TOKEN}`);
			expect(beats[beats.length - 1]).toMatchObject({
				kind: "event",
				who: "President",
				detail: "Club business · elections · adjourn",
			});
			// Exactly one beat asks for guest comments.
			expect(
				beats.filter(
					(b) => /guest/i.test(b.detail) && !/welcome/i.test(b.detail),
				),
			).toHaveLength(1);
		}
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
 * a club that disabled all four standard functionaries lost beats 4 and 12 from
 * both surfaces while the legend still listed its people.
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
 * Beat 12's gate is "functionaries who REPORT", not "functionaries" (#371).
 * A Vote Counter is a functionary — introduced at beat 4, listed in the legend —
 * but tallies votes rather than giving a report, so a Vote-Counter-only club
 * must not get a "Calls for the functionary reports" beat naming only them.
 * Vote Counter is excluded by IDENTITY (its key), which is what keys are for;
 * a club-invented functionary is presumed to report, since we cannot know
 * otherwise and an extra name in a list the GE reads out is a smaller error
 * than silently deleting the beat.
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
		// Opening remarks, guest comments (#352) and the closing. Guest comments is
		// unconditional by design: every meeting can have guests, and the spec rules
		// out a per-club toggle.
		expect(rows.filter((r) => r.who === "President")).toHaveLength(3);
	});

	it("drops the awards beat with no slots — it is gated, not ungated (#372)", () => {
		// The awards beat is the one Toastmaster-owned event beat that IS gated:
		// on the scored segments, so a club hands out only the awards it scores.
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
		expect(scored.some((r) => r.who === "Toastmaster")).toBe(true);
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
		expect(rows.some((r) => r.who === "General Evaluator · Priya")).toBe(true);
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
		expect(rows.some((r) => r.detail === "Overall meeting evaluation")).toBe(
			false,
		);
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

	it("omits both General Evaluator closing beats (11 & 13) when there's no GE slot", () => {
		const rows = expandRunSheet([]);
		expect(rows.some((r) => r.detail === "Evaluates the evaluators")).toBe(
			false,
		);
		expect(rows.some((r) => r.detail === "Overall meeting evaluation")).toBe(
			false,
		);
	});
});

describe("expandRunSheet — Timer vote-beat fallback (#367)", () => {
	const voteDetails = [
		"Timer's report · vote Best Speaker",
		"Timer's report · vote Best Table Topics",
		"Timer's report · vote Best Evaluator",
	];
	const fallbackDetails = [
		"Vote Best Speaker",
		"Vote Best Table Topics",
		"Vote Best Evaluator",
	];
	// Each vote beat belongs to a segment and is gated on it, so a club must
	// actually run all three segments for all three votes to be in play.
	const segments = [
		slot({
			id: "sp",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			assigneeName: "S",
		}),
		slot({
			id: "tt",
			roleName: "Table Topics Master",
			category: "leadership",
			assigneeName: "M",
		}),
		slot({
			id: "ev",
			roleName: "Evaluator",
			category: "evaluator",
			assigneeName: "E",
		}),
	];

	it("keeps the vote beats Timer-owned when a Timer slot exists", () => {
		const rows = expandRunSheet([
			...segments,
			slot({ roleName: "Timer", category: "functionary", assigneeName: "T" }),
		]);
		for (const detail of voteDetails) {
			expect(rows.some((r) => r.who === "Timer" && r.detail === detail)).toBe(
				true,
			);
		}
	});

	it("reassigns the vote beats to the Toastmaster of the Day (dropping the timer's-report clause) when there is no Timer slot", () => {
		const rows = expandRunSheet(segments); // no Timer slot
		for (const detail of fallbackDetails) {
			expect(
				rows.some(
					(r) => r.who === "Toastmaster of the Day" && r.detail === detail,
				),
			).toBe(true);
		}
		expect(rows.some((r) => r.who === "Timer")).toBe(false);
	});

	it("still runs all three votes (not omitted) with no Timer role", () => {
		const rows = expandRunSheet(segments);
		const votes = rows.filter((r) => fallbackDetails.includes(r.detail));
		expect(votes).toHaveLength(3);
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
		expect(rows.some((r) => r.detail.includes("vote Best"))).toBe(false);
		expect(rows.some((r) => r.detail.startsWith("Vote Best"))).toBe(false);
	});

	it("prints only the votes whose segment is on the agenda", () => {
		// A club with no Table Topics Master must not be told to vote for a Best
		// Table Topic — the segment is not on its agenda.
		const rows = expandRunSheet([timer, speaker, evaluator]);
		const votes = rows
			.filter((r) => r.detail.includes("vote Best"))
			.map((r) => r.detail);
		expect(votes).toEqual([
			"Timer's report · vote Best Speaker",
			"Timer's report · vote Best Evaluator",
		]);
	});

	it("prints the Table Topics vote once the club runs the segment", () => {
		const rows = expandRunSheet([timer, ttm]);
		expect(
			rows.some((r) => r.detail === "Timer's report · vote Best Table Topics"),
		).toBe(true);
	});
});

describe("expandRunSheet — functionary-dependent beats 4 & 12 (#367)", () => {
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
	// The functionary intro specifically — MCF's variant adds a second row that
	// also starts "Introduces the" (the handback), so the beat is identified by
	// the clause only it carries.
	const introRow = (rows: { detail: string }[]) =>
		rows.find((r) => r.detail.endsWith("; each explains their role"));

	it("omits beat 4 (functionary intro) when there are no functionary slots, even with a Toastmaster slot", () => {
		expect(introRow(expandRunSheet([totd]))).toBeUndefined();
	});

	it("renders beat 4 when at least one functionary slot exists", () => {
		const rows = expandRunSheet([totd, grammarian]);
		expect(
			rows.some(
				(r) =>
					r.who === "Toastmaster of the Day · Dana" &&
					r.detail === "Introduces the Grammarian; each explains their role",
			),
		).toBe(true);
	});

	it("beat 4 names ONLY the functionaries the club actually runs (#367)", () => {
		// Two of the four standard functionaries ⇒ both named, in slot order,
		// and the two the club does not run are not mentioned.
		expect(introRow(expandRunSheet([totd, timer, grammarian]))?.detail).toBe(
			"Introduces the Timer & Grammarian; each explains their role",
		);
		expect(introRow(expandRunSheet([totd, grammarian]))?.detail).toBe(
			"Introduces the Grammarian; each explains their role",
		);
	});

	it("beat 4 uses the club's OWN name for a renamed functionary (#368)", () => {
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
			"Introduces the Wordsmith; each explains their role",
		);
	});

	it("omits beat 12 (functionary reports) when there are no functionary slots, even with a GE slot", () => {
		const rows = expandRunSheet([ge]);
		expect(
			rows.some((r) => r.detail === "Calls for the functionary reports"),
		).toBe(false);
		// But the OTHER two GE beats (not functionary-gated) still render.
		expect(rows.some((r) => r.detail === "Evaluates the evaluators")).toBe(
			true,
		);
		expect(rows.some((r) => r.detail === "Overall meeting evaluation")).toBe(
			true,
		);
	});

	it("renders beat 12 when the GE slot exists and at least one functionary slot exists", () => {
		const rows = expandRunSheet([ge, grammarian]);
		expect(
			rows.some(
				(r) =>
					r.who === "General Evaluator · Priya" &&
					r.detail === "Calls for the functionary reports",
			),
		).toBe(true);
	});

	it("beat 4 names a club-invented functionary, and renders for a club that runs ONLY custom ones (#371)", () => {
		// #368's disable lifecycle lets a club turn off all four standard
		// functionaries and run its own. Before #371 that lost beats 4 and 12
		// from the printed agenda and both slides from the deck, while the legend
		// still listed the very same people.
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

	it("beat 4 names a custom functionary ALONGSIDE the standard ones — the same list the slide shows (#371)", () => {
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
			"Introduces the Timer, Grammarian & Joke Master; each explains their role",
		);
	});

	it("beat 12 is omitted for a Vote-Counter-only club — a Vote Counter gives no report (#371)", () => {
		const voteCounter = slot({
			id: "vc",
			roleName: "Vote Counter",
			category: "functionary",
			assigneeName: "Omar",
		});
		const rows = expandRunSheet([totd, ge, voteCounter]);
		expect(
			rows.some((r) => r.detail === "Calls for the functionary reports"),
		).toBe(false);
		// The Vote Counter is still a functionary: beat 4 introduces them.
		expect(introRow(rows)?.detail).toBe(
			"Introduces the Vote Counter; each explains their role",
		);
	});

	it("beats 4 & 12 are omitted when the only candidate is a standard KEY recategorised out of the functionaries (#371)", () => {
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
		expect(
			rows.some((r) => r.detail === "Calls for the functionary reports"),
		).toBe(false);
	});

	it("beat 12 renders for a club whose only functionary is a custom one (#371)", () => {
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
		expect(
			rows.some((r) => r.detail === "Calls for the functionary reports"),
		).toBe(true);
	});

	it("MCF variant: beat 4 (GE-owned) is still omitted when there are no functionary slots, despite a GE slot existing", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(introRow(expandRunSheet([totd, ge], template))).toBeUndefined();
	});

	it("MCF variant: beat 4 renders owned by the General Evaluator when GE and a functionary both exist", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, ge, grammarian], template);
		expect(introRow(rows)).toMatchObject({
			who: "General Evaluator · Priya",
			detail: "Introduces the Grammarian; each explains their role",
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

	// The handback (MCF only): with the General Evaluator introducing the
	// functionaries, the run sheet has to say out loud that the Toastmaster is
	// back for the speeches.
	const handbackRow = (rows: { detail: string }[]) =>
		rows.find((r) => r.detail === "Introduces the speakers");

	it("MCF variant: the Toastmaster introduces the speakers, in a row between the GE's intro and the first speech", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		const rows = expandRunSheet([totd, ge, grammarian, speaker], template);
		expect(handbackRow(rows)).toMatchObject({
			who: "Toastmaster of the Day · Dana",
			detail: "Introduces the speakers",
		});
		const at = (pred: (r: { detail: string }) => boolean) =>
			rows.findIndex(pred);
		expect(
			at((r) => r.detail.endsWith("; each explains their role")),
		).toBeLessThan(at((r) => r.detail === "Introduces the speakers"));
		expect(at((r) => r.detail === "Introduces the speakers")).toBeLessThan(
			at((r) => r.detail === "Prepared speech"),
		);
	});

	it("MCF variant: no handback row when the club runs no speakers — there is nobody to introduce", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(
			handbackRow(expandRunSheet([totd, ge, grammarian], template)),
		).toBeUndefined();
	});

	it("MCF variant: no handback row without a Toastmaster slot", () => {
		const template = buildRunOfShow({ geIntroducesFunctionaries: true });
		expect(
			handbackRow(expandRunSheet([ge, grammarian, speaker], template)),
		).toBeUndefined();
	});

	it("default variant: no handback row — the Toastmaster ran the intro and never left", () => {
		expect(
			handbackRow(expandRunSheet([totd, ge, grammarian, speaker])),
		).toBeUndefined();
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

// Beat 12's gate, and the deck's functionary-REPORTS slide (#371). Narrower
// than `hasAnyFunctionaryRole` by exactly one standard role: the Vote Counter,
// who is a functionary but gives no report.
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

	it("is FALSE for a Vote-Counter-only club, though beat 4 still introduces them", () => {
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
		// …so the whole shortfall survives: a 24-minute agenda in a 90-minute
		// booking. The banner is NOT suppressed — it is the prompt that gets
		// `lengthMinutes` corrected; it just stops naming a segment the club does
		// not run.
		expect(flex.projectedMinutes).toBe(24);
		expect(flex.status).toBe("under");
		const msg = flexBannerMessage(flex);
		expect(msg).toBe(
			"Agenda ends 66 min early — consider shortening the meeting length.",
		);
		expect(msg).not.toMatch(/table topics/i);
	});
});

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
	const awardsRow = (slots: AgendaSlot[]): AgendaRow | undefined =>
		expandRunSheet(slots).find((r) => r.detail.startsWith("Awards ·"));

	it("lists every category when the club runs all three scored segments", () => {
		expect(awardsRow([speaker, ttm, evaluator])?.detail).toBe(
			"Awards · Best Table Topic, Best Evaluator & Best Speaker",
		);
	});

	it("omits Best Table Topic for a club with no Table Topics Master", () => {
		expect(awardsRow([speaker, evaluator])?.detail).toBe(
			"Awards · Best Evaluator & Best Speaker",
		);
	});

	it("names a single category without a conjunction", () => {
		expect(awardsRow([speaker])?.detail).toBe("Awards · Best Speaker");
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
		expect(awardsRow([renamed])?.detail).toBe("Awards · Best Table Topic");
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
		fallback: { unless: TTM, owner: TM },
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
				detail: "Introduces the General Evaluator",
				minutes: 0,
				marks: null,
			},
		]);
	});

	it("swaps only the detail when the fallback names no owner", () => {
		const withDetail: Beat = {
			...beat,
			fallback: {
				unless: { roleKey: "timer", roleName: "Timer" },
				detail: "Vote Best Speaker",
			},
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
			detail: "Vote Best Speaker",
		});
	});

	it("omits the beat when neither the owner nor the fallback owner has a slot", () => {
		expect(expandRunSheet([], [beat])).toEqual([]);
	});
});

describe("renderUnowned (#363)", () => {
	it("renders the bare role name when the owning role has no slot", () => {
		const beat: Beat = {
			kind: "role",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Vote Best Speaker",
			minutes: 1,
			renderUnowned: true,
		};
		expect(expandRunSheet([], [beat])).toEqual([
			{
				who: "Toastmaster of the Day",
				detail: "Vote Best Speaker",
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
			detail: "Vote Best Speaker",
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
});
