import { describe, expect, it } from "vitest";
import { withBeatIds } from "#/test/template-beat-ids";
import { materialiseRunOfShow } from "./agenda-materialise";
import {
	type AgendaSlot,
	buildRunOfShow,
	expandRunSheet,
} from "./agenda-runsheet";
import {
	buildTemplateRows,
	type TemplateRoleRow,
} from "./agenda-template-rows";

/**
 * Adoption must not change the printed sheet.
 *
 * That is 622a's entire promise, and the release is worthless without it: a
 * club that edits one duration and finds its whole agenda subtly rearranged has
 * been handed a worse product than the one it had.
 *
 * A parity comparison ALONE cannot see a defect present on both sides, so the
 * band-boundary and beat-count goldens live in `agenda-materialise.test.ts` and
 * this file compares the two renderers row for row on top of them.
 */

let n = 0;
function slot(
	roleKey: string,
	roleName: string,
	assigneeName: string | null,
	over: Partial<AgendaSlot> = {},
): AgendaSlot {
	return {
		id: `s${n++}`,
		roleKey,
		roleName,
		category: "leadership",
		isSpeakerRole: false,
		slotIndex: 0,
		assigneeName,
		...over,
	} as AgendaSlot;
}

/** A club running the standard roles, with two speakers and two evaluators. */
function standardSlots(geName: string | null = "Dana"): AgendaSlot[] {
	n = 0;
	return [
		slot("sergeant_at_arms", "Sergeant-at-Arms", "Ann"),
		slot("president", "President", "Ben"),
		slot("toastmaster_of_the_day", "Toastmaster of the Day", "Cara"),
		slot("general_evaluator", "General Evaluator", geName),
		slot("table_topics_master", "Table Topics Master", "Eli"),
		// Regression: ISSUE-002 — these carried no speech title and no window, so
		// BOTH renderers printed "Prepared speech" with null marks and the
		// comparison below agreed on the wrong thing. A parity test is only as
		// good as the fields its fixture populates.
		// Found by /qa on 2026-08-31.
		slot("speaker", "Speaker", "Fay", {
			isSpeakerRole: true,
			category: "speaker",
			slotIndex: 0,
			speechTitle: "Data That Persuades",
			projectLevel: "Level 3",
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot("speaker", "Speaker", "Gus", {
			isSpeakerRole: true,
			category: "speaker",
			slotIndex: 1,
			speechTitle: "From Nervous to Natural",
			projectLevel: "Level 2",
			minMinutes: 5,
			maxMinutes: 7,
		}),
		slot("evaluator", "Evaluator", "Hal", {
			isSpeakerRole: true,
			category: "evaluator",
			slotIndex: 0,
			evaluatesSlotId: "s5",
		}),
		slot("evaluator", "Evaluator", "Ivy", {
			isSpeakerRole: true,
			category: "evaluator",
			slotIndex: 1,
			evaluatesSlotId: "s6",
		}),
		slot("timer", "Timer", "Jo", { category: "functionary" }),
		slot("grammarian", "Grammarian", "Kit", { category: "functionary" }),
		slot("ah_counter", "Ah-Counter", "Lou", { category: "functionary" }),
	];
}

/** The club's roles, as the template path reads them. */
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

function adoptedRows(geIntroducesFunctionaries: boolean, slots: AgendaSlot[]) {
	const seeds = withBeatIds(
		materialiseRunOfShow(geIntroducesFunctionaries, null),
	);
	return buildTemplateRows(seeds, ROLES, slots).filter(
		(r) => r.section !== true,
	);
}

function codeRows(geIntroducesFunctionaries: boolean, slots: AgendaSlot[]) {
	// (slots, template) — not the other way round.
	return expandRunSheet(slots, buildRunOfShow({ geIntroducesFunctionaries }));
}

describe("adoption preserves the printed sheet", () => {
	for (const variant of [false, true] as const) {
		it(`row for row, geIntro=${variant}`, () => {
			const slots = standardSlots();
			const before = codeRows(variant, slots);
			const after = adoptedRows(variant, slots);

			expect(after.map((r) => r.who)).toEqual(before.map((r) => r.who));
			expect(after.map((r) => r.minutes)).toEqual(before.map((r) => r.minutes));
			expect(after.map((r) => r.detail)).toEqual(before.map((r) => r.detail));
		});

		it(`keeps the hand-offs, geIntro=${variant}`, () => {
			const slots = standardSlots();
			expect(adoptedRows(variant, slots).filter((r) => r.handoff)).toHaveLength(
				codeRows(variant, slots).filter((r) => r.handoff).length,
			);
		});
	}

	it("keeps each speech's title, window and evaluator target", () => {
		// Regression: ISSUE-002 — an adopted agenda printed "Prepared speech" with
		// no marks, and "Evaluates a speaker" instead of naming who. The marks are
		// the sharp end: the Timer works from the printed sheet.
		// Found by /qa on 2026-08-31.
		const rows = adoptedRows(true, standardSlots());

		const speech = rows.find((r) => r.detail?.includes("Data That Persuades"));
		expect(speech).toBeDefined();
		expect(speech?.detail).toContain("Level 3");
		expect(speech?.marks).toEqual({ green: 5, yellow: 6, red: 7 });

		// The fixture links by slot id without an `evaluates.speakerName`, so this
		// exercises the SLOT-LABEL fallback (#512's middle case) — the same one
		// that prints "Evaluates Speaker 3" for an unclaimed speaking slot. The
		// named form is covered by the live agenda, which carries the relation.
		expect(rows.some((r) => r.detail === "Evaluates Speaker 1")).toBe(true);
		expect(rows.some((r) => r.detail === "Evaluates a speaker")).toBe(false);
	});

	it("names a live holder, and FOLLOWS a holder change", () => {
		// A frozen name passes any same-fixture comparison. Changing the holder
		// between two renders is what proves the token stayed live rather than
		// being resolved once at adoption — which would print, every week, the
		// name of whoever happened to hold the role the day it was adopted.
		const seeds = withBeatIds(materialiseRunOfShow(true, null));
		const first = buildTemplateRows(seeds, ROLES, standardSlots("Dana"));
		const second = buildTemplateRows(seeds, ROLES, standardSlots("Zed"));

		expect(first.some((r) => r.detail?.includes("Dana"))).toBe(true);
		expect(second.some((r) => r.detail?.includes("Zed"))).toBe(true);
		expect(second.some((r) => r.detail?.includes("Dana"))).toBe(false);
	});

	it("fans a THIRD speaker out without touching the template", () => {
		// The materialised speech beat repeats over the speaker slots. If it were
		// stored as a literal row instead, adding a speaker would silently print
		// two speeches for three speakers.
		const seeds = withBeatIds(materialiseRunOfShow(false, null));
		const two = buildTemplateRows(seeds, ROLES, standardSlots());
		const three = buildTemplateRows(seeds, ROLES, [
			...standardSlots(),
			slot("speaker", "Speaker", "Moe", {
				isSpeakerRole: true,
				category: "speaker",
				slotIndex: 2,
			}),
		]);
		expect(three.length).toBeGreaterThan(two.length);
	});
});
