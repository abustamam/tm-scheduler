/**
 * Every call site that must forward a club's Table Topics window (#443).
 *
 * ## Why this file exists, stated plainly
 *
 * The first cut of #443 wired ONE of the five surfaces. `buildSlideDeck` got the
 * club's window; `resolveAgendaRows` — the seam the printed run sheet, the
 * on-screen agenda and the present page all share — did not, and neither did
 * `materialiseRunOfShow`, which FREEZES the marks it builds into the template
 * row. So a club setting 1:00/2:30 got a projector saying "2:30 maximum" beside
 * a printed Timer row still saying red at 2:00: the exact contradiction the
 * issue exists to close, inverted rather than fixed.
 *
 * Worse, a comment on `RunOfShowConfig.tableTopicsLimits` justified making that
 * field optional by claiming the risk was "covered by
 * table-topics-limits-wiring.guard.test.ts" — this file, which did not exist.
 * Three independent review passes each found the gap, and all three found it by
 * reading the wiring rather than by running anything, because nothing failed.
 *
 * ## What is enforced where, and why it is split
 *
 * `resolveAgendaRows` takes the limits as a REQUIRED field, so typecheck names
 * every route that forgets — that is the real gate for the three run-sheet
 * surfaces, and it is why this file does not need to police them.
 *
 * `RunOfShowConfig.tableTopicsLimits` stays OPTIONAL, because requiring it would
 * mean editing ~200 test call sites to say "no opinion". That is the hole this
 * file actually covers: the two PRODUCTION callers of `buildRunOfShow` that hold
 * club data and could silently take the default.
 *
 * Comment-blind via `readSource` for the must-be-present assertions, since this
 * header names several of the very patterns below.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

describe("table topics limits wiring (#443)", () => {
	it("resolveAgendaRows accepts the window and forwards it", () => {
		const src = readSource("src/lib/agenda-runsheet.ts");
		// Required, not optional — the field being required is what makes
		// typecheck the gate for the three routes below. Asserted as two facts
		// rather than one span: `readSource` blanks comments while PRESERVING
		// offsets, so a docblock between them inflates any distance window and
		// makes a span regex fail for a reason unrelated to the wiring.
		expect(src).toContain("export function resolveAgendaRows(input: {");
		expect(src).toContain("tableTopicsLimits: TableTopicsLimits | null;");
		expect(src, "must be required, not optional").not.toContain(
			"tableTopicsLimits?: TableTopicsLimits | null;\n\ttemplate",
		);
		// And it must actually reach the builder, not merely be accepted.
		expect(src).toMatch(
			/buildRunOfShow\(\{[\s\S]{0,160}tableTopicsLimits: input\.tableTopicsLimits/,
		);
	});

	it("every route that resolves agenda rows passes the club window", () => {
		// The three run-sheet surfaces. Typecheck already refuses an omission, so
		// this pins that what they pass is the CLUB's value rather than a literal
		// null someone added to silence the compiler.
		for (const path of [
			"src/routes/club.$clubId.meeting.$meetingId.tsx",
			"src/routes/club.$clubId_.meeting.$meetingId.print.tsx",
			"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
		]) {
			const src = readSource(path);
			expect(src, `${path} calls resolveAgendaRows`).toContain(
				"resolveAgendaRows({",
			);
			expect(src, `${path} forwards the club window`).toMatch(
				/resolveAgendaRows\(\{[\s\S]{0,400}tableTopicsLimits: \{[\s\S]{0,200}tableTopicsMinSeconds/,
			);
		}
	});

	it("the deck builder passes the club window too", () => {
		const src = readSource("src/lib/agenda-slides.ts");
		expect(src).toMatch(/buildRunOfShow\(\{[\s\S]{0,160}tableTopicsLimits/);
		expect(src).toContain("formatTableTopicsTiming(tableTopicsLimits)");
	});

	it("materialisation snapshots the CLUB's marks, not ours", () => {
		// `beatSeed` persists `beat.marks` into mark_green/mark_yellow/mark_red,
		// and `resolveMarks` makes the stored copy what renders — so omitting the
		// limits here freezes the standard window into the club's own rows
		// permanently, on every surface including the templated deck.
		const src = readSource("src/lib/agenda-materialise.ts");
		expect(src).toContain("export function materialiseRunOfShow(");
		expect(src).toContain("tableTopicsLimits: TableTopicsLimits | null,");
		expect(src).toMatch(/buildRunOfShow\(\{[\s\S]{0,120}tableTopicsLimits,/);

		const caller = readSource("src/server/meeting-agenda-edit-logic.ts");
		expect(caller).toContain("materialiseRunOfShow(");
		// Whitespace-tolerant on purpose: Biome wraps this call across lines once
		// the second argument makes it long enough, and a guard that breaks when
		// the FORMATTER runs fails for a reason that has nothing to do with the
		// wiring it exists to police.
		expect(caller).toMatch(
			/materialiseRunOfShow\(\s*geIntroducesFunctionaries,\s*tableTopicsLimits,?\s*\)/,
		);
		// And the club columns must actually be selected, or the caller forwards
		// two undefineds that typecheck as null.
		expect(caller).toContain(
			"tableTopicsMinSeconds: clubs.tableTopicsMinSeconds",
		);
	});

	it("the loader ships the columns every surface above reads", () => {
		const src = readSource("src/server/meetings.ts");
		expect(src).toContain("tableTopicsMinSeconds: true");
		expect(src).toContain("tableTopicsMaxSeconds: true");
		expect(src).toMatch(
			/tableTopicsMinSeconds: club\?\.tableTopicsMinSeconds \?\? null/,
		);
	});
});
