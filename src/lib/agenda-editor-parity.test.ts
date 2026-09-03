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
import { buildTemplateRowsWithSource } from "./agenda-template-rows";
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
});
