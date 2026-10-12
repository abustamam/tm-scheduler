// @vitest-environment jsdom
//
// How many blank sheets a duplex run of agenda copies gets (#1166).
//
// A copy that prints an odd number of pages leaves the next copy on a back, so
// the rule needs how many pages each copy REALLY prints. `FitPage` lets a long
// agenda flow onto extra pages (and its flow branch is set by an effect, which
// no static render runs), so these tests stub the one thing the component
// reads — each sheet's laid-out height — the way a browser would report it
// after the flow.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgendaCopies, blanksAfterCopies, sheetPages } from "./agenda-copies";
import type { AgendaHeader } from "./meeting-agenda-print";

const header: AgendaHeader = {
	clubName: "Downtown Toastmasters",
	logoUrl: null,
	clubNumber: "1234",
	district: null,
	mission: null,
	meetingSchedule: null,
	dateLong: "Wednesday, July 22, 2026",
	dateShort: "Wed · Jul 22, 2026",
	timeRange: "7:00 – 8:15 PM",
	theme: null,
	wordOfTheDay: null,
	location: null,
	announcements: null,
	meetingNumber: null,
};

/** Each non-blank sheet's reported height, by document order. */
let heights: number[] = [];

const SHEET = ".agenda-page:not([data-agenda-blank])";
const original = Object.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	"offsetHeight",
);

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			const i = [...document.querySelectorAll(SHEET)].indexOf(this);
			return i >= 0 ? (heights[i] ?? 1056) : 0;
		},
	});
});
afterEach(() => {
	cleanup();
	if (original)
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
});

function renderCopies(
	layout: "grid" | "timing",
	copies: number,
	duplex: boolean,
	sheetHeights: number[],
) {
	heights = sheetHeights;
	render(
		<AgendaCopies
			layout={layout}
			copies={copies}
			duplex={duplex}
			header={header}
			roles={[]}
			officers={[]}
			explainers={[]}
			rows={[]}
		/>,
	);
	return {
		sheets: document.querySelectorAll(SHEET).length,
		blanks: document.querySelectorAll("[data-agenda-blank]").length,
	};
}

describe("sheetPages", () => {
	it("is one page for a sheet exactly a page tall, and counts the overflow", () => {
		expect(sheetPages(1056)).toBe(1);
		expect(sheetPages(1058)).toBe(1); // FitPage's own 2px guard
		expect(sheetPages(1059)).toBe(2);
		expect(sheetPages(2112)).toBe(2);
		expect(sheetPages(2200)).toBe(3);
		expect(sheetPages(0)).toBe(1);
	});
});

describe("blanksAfterCopies", () => {
	it("puts a blank after an odd copy, never after the last", () => {
		expect(blanksAfterCopies([1, 1, 1], true)).toEqual([true, true, false]);
		expect(blanksAfterCopies([2, 3, 1], true)).toEqual([false, true, false]);
		expect(blanksAfterCopies([1, 1], false)).toEqual([false, false]);
	});
});

describe("AgendaCopies — blanks follow the pages each copy really prints (#1166)", () => {
	it("one-page layout that fits: a blank between copies", () => {
		expect(renderCopies("grid", 3, true, [])).toEqual({ sheets: 3, blanks: 2 });
	});

	it("a one-page layout whose copy overflows to two pages gets NO blank after it", () => {
		// Copy 1 is 2 pages long, so copy 2 already starts on a front.
		expect(renderCopies("grid", 2, true, [1800, 1056])).toEqual({
			sheets: 2,
			blanks: 0,
		});
	});

	it("blanks only where the preceding copy is odd", () => {
		// Pages per copy: 1, 2, 1 -> a blank after copy 1 only.
		expect(renderCopies("grid", 3, true, [1056, 1800, 1056])).toEqual({
			sheets: 3,
			blanks: 1,
		});
	});

	it("a two-page layout that fits needs none", () => {
		expect(renderCopies("timing", 2, true, [])).toEqual({
			sheets: 4,
			blanks: 0,
		});
	});

	it("a two-page layout that overflows to three pages DOES get one", () => {
		// Copy 1: 1056 + 2000 (two pages) = 3 pages.
		expect(renderCopies("timing", 2, true, [1056, 2000, 1056, 1056])).toEqual({
			sheets: 4,
			blanks: 1,
		});
	});

	it("never pads without duplex, whatever the lengths", () => {
		expect(renderCopies("grid", 3, false, [])).toEqual({
			sheets: 3,
			blanks: 0,
		});
	});
});
