import { describe, expect, it } from "vitest";
import { paginate, unitsOf } from "./agenda-paginate";

/** Heights per sheet, for the capacity assertions. */
const used = (heights: number[], sheets: number[][]) =>
	sheets.map((s) => s.reduce((a, i) => a + heights[i], 0));

describe("paginate", () => {
	// protects=a unit is never cut: every unit index appears on exactly one sheet,
	//   whole, whatever the capacities are
	// fails_when=a unit is split across two sheets, dropped, or listed twice
	// no_claim=that the units are the right ones (unitsOf, below, and the Chrome
	//   test's presenter-group check)
	it("puts every unit on exactly one sheet, whole", () => {
		const heights = [40, 90, 30, 70, 20, 80, 60, 50];
		const sheets = paginate(heights, 150, 200);
		expect(sheets.flat().sort((a, b) => a - b)).toEqual(
			heights.map((_, i) => i),
		);
		expect(new Set(sheets.flat()).size).toBe(heights.length);
	});

	// protects=each sheet's capacity is honoured: the first sheet's differs from the
	//   rest, and no sheet that holds more than one unit exceeds its own
	// fails_when=the first capacity is used for every sheet, the rest's for the first,
	//   or a sheet is filled past its capacity
	// no_claim=that a sheet is filled as full as possible (greedy fill leaves the
	//   room a next unit does not fit in)
	it("respects the first capacity and the rest capacity", () => {
		const heights = [60, 60, 60, 60, 60, 60, 60];
		const sheets = paginate(heights, 130, 190);
		// 130 holds two 60s, 190 holds three.
		expect(sheets).toEqual([
			[0, 1],
			[2, 3, 4],
			[5, 6],
		]);
		const caps = [130, 190, 190];
		used(heights, sheets).forEach((u, i) => {
			expect(u, `sheet ${i}`).toBeLessThanOrEqual(caps[i]);
		});
	});

	// protects=order: a short unit is never pulled ahead of a taller one that did
	//   not fit, to fill a gap
	// fails_when=the packing is first-fit-decreasing or backfills, so units print out
	//   of order
	// no_claim=that the packing is optimal: it is deliberately not
	it("keeps units in order and closes a sheet at the first unit that does not fit", () => {
		// 100 | 100 doesn't fit after 60+30, but the 10 after it would; it must wait.
		expect(paginate([60, 30, 100, 10], 100, 100)).toEqual([[0, 1], [2], [3]]);
	});

	// protects=a unit taller than a whole sheet is placed alone on its own sheet, not
	//   refused, not cut, and not stacked with a neighbour; the next unit starts fresh
	// fails_when=an oversized unit is dropped, shares a sheet, or loops forever
	// no_claim=that it prints legibly: its sheet's FitPage scales it, or flows it past
	//   MIN_FIT_SCALE, which is unsupported input
	it("places an oversized unit alone", () => {
		expect(paginate([100, 5000, 100], 500, 600)).toEqual([[0], [1], [2]]);
		// First in the run, on the first sheet.
		expect(paginate([5000, 100], 500, 600)).toEqual([[0], [1]]);
	});

	// protects=nothing to print is no sheets, and a run that fits stays on one
	// fails_when=an empty sheet is emitted for no units, or a run that fits is split
	// no_claim=what a caller does with zero sheets
	it("returns no sheets for no units, and one when everything fits", () => {
		expect(paginate([], 500, 600)).toEqual([]);
		expect(paginate([100, 100, 100], 500, 600)).toEqual([[0, 1, 2]]);
	});
});

describe("unitsOf", () => {
	const row = (group: number) => ({ group, head: false });
	const head = { group: -1, head: true };

	// protects=a presenter group's entries share a unit, so a sheet break cannot fall
	//   between one person's consecutive beats
	// fails_when=neighbours in one group are separate units, or entries in different
	//   groups are merged
	// no_claim=how the groups were formed (groupByPresenter's own tests)
	it("keeps a presenter group together and separates different groups", () => {
		expect(unitsOf([row(0), row(0), row(0), row(1), row(2), row(2)])).toEqual([
			[0, 1, 2],
			[3],
			[4, 5],
		]);
	});

	// protects=a section band can never end a sheet: it is merged into the unit that
	//   follows it, as is a hand-off that kept its own band
	// fails_when=a head is its own unit (so the packer may close a sheet right after
	//   it), or is attached to the unit BEFORE it
	// no_claim=that the band's segment then fits (the packer decides that)
	it("merges a section band, or a hand-off band, into the unit that follows", () => {
		expect(unitsOf([row(0), head, row(1), row(1), head, head, row(2)])).toEqual(
			[[0], [1, 2, 3], [4, 5, 6]],
		);
	});

	// protects=a trailing hand-off band stays with the last unit rather than being a
	//   unit alone, and a run of nothing but heads is still one unit
	// fails_when=a head with nothing after it is dropped, or becomes a sheet of its own
	// no_claim=that a real agenda ends on one
	it("keeps heads with nothing after them", () => {
		expect(unitsOf([row(0), row(1), head])).toEqual([[0], [1, 2]]);
		expect(unitsOf([head, head])).toEqual([[0, 1]]);
		expect(unitsOf([])).toEqual([]);
	});

	// protects=section-never-last end to end: pack units made from a run whose
	//   sections fall where the greedy fill would otherwise close a sheet
	// fails_when=any sheet's last entry is a section band
	// no_claim=real heights (the Chrome test packs measured ones)
	it("no sheet ends on a section band", () => {
		// entries: 0 row, 1 section, 2 row, 3 row, 4 section, 5 row
		const items = [row(0), head, row(1), row(2), head, row(3)];
		const units = unitsOf(items);
		const heights = [50, 50, 50, 50];
		for (const cap of [50, 100, 120, 150]) {
			const sheets = paginate(heights.slice(0, units.length), cap, cap);
			for (const sheet of sheets) {
				const lastEntry = units[sheet.at(-1) as number].at(-1) as number;
				expect(items[lastEntry].head, `capacity ${cap}`).toBe(false);
			}
		}
	});
});
