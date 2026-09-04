/**
 * The editor's clock and the printed agenda's must agree, row for row.
 *
 * They call the same three functions today — `AgendaEditor`'s `useAgendaModel`
 * and `print.tsx:154-168` both run `resolveAgendaRows` → `applyFlex` →
 * `buildTimeline` — so this cannot fail while that holds. That IS the point: it
 * fails loudly the day someone gives the editor a derivation of its own.
 *
 * NOT the only guard on the clock, and that distinction matters. A parity test
 * cannot see a defect present on BOTH sides: fork the pipeline in a way that
 * breaks both surfaces identically and this still passes. `agenda-budget.test
 * .ts` carries the absolute golden numbers (92 minutes, ends 8:17) for exactly
 * that reason, and neither is redundant.
 */
import { describe, expect, it } from "vitest";
import { contestFixture } from "#/test/contest-fixture";
import { applyFlex, resolveAgendaRows } from "./agenda-runsheet";
import {
	buildTemplateRowsWithSource,
	refreshTableTopicsMarks,
	type TemplateBeatRow,
	type TemplateRoleRow,
} from "./agenda-template-rows";
import { buildTimeline } from "./agenda-timing";

/** What `print.tsx` does. */
function printClock(f: ReturnType<typeof contestFixture>) {
	return buildTimeline(
		applyFlex(
			resolveAgendaRows({
				geIntroducesFunctionaries: false,
				tableTopicsLimits: null,
				template: { beats: f.beats, roles: f.roles },
				slots: f.slots,
			}),
			f.length,
		).rows,
		f.startsAt,
		f.tz,
	);
}

/** What `useAgendaModel` does — the sourced variant, rows only. */
function editorClock(f: ReturnType<typeof contestFixture>) {
	return buildTimeline(
		applyFlex(
			buildTemplateRowsWithSource(f.beats, f.roles, f.slots).map((e) => e.row),
			f.length,
		).rows,
		f.startsAt,
		f.tz,
	);
}

describe("editor / print clock parity", () => {
	// Three arities, because a single one is the #522 trap: the repeat block is
	// where the two could diverge, and it behaves differently at each.
	for (const contestants of [1, 2, 4]) {
		it(`agrees row for row at ${contestants} contestant(s)`, () => {
			const f = contestFixture(contestants);
			const print = printClock(f);
			const editor = editorClock(f);
			expect(editor.map((r) => [r.who, r.time, r.minutes])).toEqual(
				print.map((r) => [r.who, r.time, r.minutes]),
			);
		});
	}

	it("produces the 21 rows the seeded contest prints at four contestants", () => {
		// Vacuity guard: an empty timeline would satisfy the equality above.
		expect(editorClock(contestFixture(4))).toHaveLength(21);
	});

	it("carries the timing marks identically, not just the clock", () => {
		// The marks are what a Timer reads. Comparing only `time` would pass on a
		// pipeline that dropped them from one side.
		const f = contestFixture(4);
		expect(editorClock(f).map((r) => r.marks)).toEqual(
			printClock(f).map((r) => r.marks),
		);
	});

	it("agrees about the club's Table Topics window, from two DIFFERENT seams (#679)", () => {
		// The parity above rests on both surfaces calling the same functions in the
		// same order. The Table Topics re-derivation deliberately breaks that
		// symmetry: the print route gets it inside `resolveAgendaRows`, and the
		// editor gets it from `loadAgendaDraft`, which refreshes the rows BEFORE
		// they cross the server-fn boundary. So the shared-function argument does
		// not cover this row, and nothing else would notice one seam losing it —
		// the contest fixture has no Table Topics beat at all, so every assertion
		// above is blind to the whole feature.
		//
		// Modelled exactly as production does it on each side. ABSOLUTE marks, from
		// a club window (1:00–2:30) that differs from the frozen snapshot in every
		// component, so a dropped refresh on either side shows up as 1/1.5/2.
		const club = { minSeconds: 60, maxSeconds: 150 };
		const beats: TemplateBeatRow[] = [
			{
				id: "tt",
				sortOrder: 0,
				kind: "role",
				label: "Table Topics Master",
				detail: null,
				minutes: 10,
				roleKey: "table_topics_master",
				repeatsRoleKey: null,
				flex: true,
				handoff: false,
				markGreen: 1,
				markYellow: 1.5,
				markRed: 2,
			},
		];
		const roles: TemplateRoleRow[] = [
			{
				key: "table_topics_master",
				name: "Table Topics Master",
				isSpeakerRole: false,
			},
		];

		// What `print.tsx` does.
		const print = resolveAgendaRows({
			geIntroducesFunctionaries: false,
			tableTopicsLimits: club,
			template: { beats, roles },
			slots: [],
		});
		// What the editor does: `loadAgendaDraft` refreshed the rows, and
		// `useAgendaModel` passes them straight through.
		const editor = buildTemplateRowsWithSource(
			refreshTableTopicsMarks(beats, club),
			roles,
			[],
		).map((e) => e.row);

		expect(print[0]?.marks).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
		expect(editor.map((r) => r.marks)).toEqual(print.map((r) => r.marks));
	});
});
