// @vitest-environment jsdom
/**
 * A compact run of show keeps a long agenda in the layout the club chose (#1226).
 *
 * After #1225 an agenda too long for its layout switches to Timing, which keeps
 * the page count honest and takes the club's layout away. `MeetingAgendaPrint`
 * now climbs a ladder, `regular` -> `compact` -> the caller's `onWouldFlow`, one
 * rung per sheet that reports it would flow. Compact keeps every declared type
 * size and every string and removes vertical whitespace only.
 *
 * Three layers, because each sees what the others cannot:
 *
 *   - static markup (`renderToStaticMarkup`, jsdom DOM): what regular renders,
 *     byte for byte, and what compact renders. Cannot run `FitPage`'s measuring
 *     effect, so cannot say a real agenda climbs.
 *   - jsdom with `scrollHeight` stubbed: the ladder's wiring and its reset.
 *     Cannot say how tall anything really is.
 *   - Chrome, `FitPage`'s REAL effect in a client React root
 *     (`src/test/print-compact-entry.tsx`): a real agenda climbs, fits its own
 *     sheet count, and keeps its text. Heights are this machine's fallback face's
 *     (no webfont resolves), and CI pins a different one, so every geometry
 *     assertion carries the measured numbers in its message.
 *
 * Measured on macOS (cliff = (1056 - 2) / 0.72 = 1464px, the tallest sheet's
 * natural `[data-fit-inner].scrollHeight`), `thrAgendaLong`, the agenda #1225's
 * own tests use because it flows on every machine:
 *
 *   layout     regular   compact   scale
 *   grid         1729      1390    0.751
 *   editorial    1649      1328    0.768
 *   spacious p2  1903      1172    0.778
 *
 * Grid's regular row was 22px of line box for 13px of text: the cell holding the
 * two spans took the page's 16px font for its line box, and the spans' own 10 and
 * 10.5 could not shrink it. Compact sizes the cell to its text. Without that,
 * halving the padding alone left Grid at 1572 and over the cliff.
 */
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENDA_LAYOUT_PAGES, AGENDA_LAYOUTS } from "#/lib/agenda-layouts";
import {
	EDITORIAL_MIN_PRINTED_PT,
	pxToPt,
	RUN_NARRATIVE_TYPE,
} from "#/lib/agenda-print-type";
import type { TimelineRow } from "#/lib/agenda-timing";
import { runClientEntry } from "#/test/client-bundle-chrome";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import type {
	ClimbSnapshot,
	CompactScenario,
	TextSnapshot,
} from "#/test/print-compact-entry";
import {
	type PrintCompactFixtureId,
	printCompactAgenda,
} from "#/test/print-compact-fixtures";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
// The committed baseline: `renderToStaticMarkup` of the MCF fixture at each layout,
// written on this branch's base commit BEFORE any code change. Its font weights were remapped
// by script in #1402 (800 to 700, 500 to 400/600); regenerating must be followed by the same remap.
import baseline from "./__snapshots__/print-compact-baseline.json";
import {
	type AgendaLayout,
	MeetingAgendaPrint,
	type PrintDensity,
} from "./meeting-agenda-print";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const QR = "https://example.test/meeting";

/** A fixture with enough contestants that every layout still flows at compact.
 *  Not the seven the issue names: see `CONTEST` below. */
const CONTEST: PrintCompactFixtureId = "contestDense16";

function view(
	layout: AgendaLayout,
	over: Partial<React.ComponentProps<typeof MeetingAgendaPrint>> = {},
) {
	return (
		<MeetingAgendaPrint
			layout={layout}
			header={MCF_HEADER}
			roles={MCF_ROLES}
			officers={MCF_OFFICERS}
			explainers={MCF_EXPLAINERS}
			rows={MCF_ROWS}
			qrUrl={QR}
			{...over}
		/>
	);
}

describe("regular density is the markup that shipped", () => {
	// protects=an agenda that fits prints exactly as it did before #1226
	// fails_when=any byte of an MCF layout's static markup differs from the baseline
	//   committed before the change (a regular-density style, wrapper or attribute
	//   leaking out of compact)
	// no_claim=what a long agenda renders at compact, or what Chrome measures
	for (const layout of AGENDA_LAYOUTS) {
		it(`${layout}: MCF markup is byte-identical to the baseline`, () => {
			expect(renderToStaticMarkup(view(layout))).toBe(
				(baseline as Record<string, string>)[layout],
			);
		});
	}

	// protects=the baseline file really holds all four layouts, so the four tests
	//   above compare against something
	// fails_when=a layout's entry is missing or empty (undefined would equal nothing,
	//   but an empty string would equal an empty render)
	// no_claim=that the baseline is the right markup, which is what it was before
	it("has a real baseline for every layout", () => {
		for (const layout of AGENDA_LAYOUTS)
			expect(
				(baseline as Record<string, string>)[layout]?.length ?? 0,
				layout,
			).toBeGreaterThan(5000);
	});

	// protects=compact is a different render, so the comparisons here can fail
	// fails_when=initialDensity is ignored and compact renders as regular
	// no_claim=how compact differs, which the tests below say
	it("compact is not the baseline", () => {
		for (const layout of AGENDA_LAYOUTS)
			expect(
				renderToStaticMarkup(view(layout, { initialDensity: "compact" })),
				layout,
			).not.toBe((baseline as Record<string, string>)[layout]);
	});
});

/** A row, with the fields the layouts read. */
function row(over: Partial<TimelineRow> & { who: string; time: string }) {
	return {
		detail: "",
		minutes: 3,
		marks: null,
		...over,
	} as TimelineRow;
}

/** beat A, a hand-off into a SECTION, the section, beat B, two hand-offs into
 *  beat C, beat C, and a hand-off with nothing after it. */
const FOLD_ROWS: TimelineRow[] = [
	row({ who: "Alpha Beat", detail: "alpha detail", time: "6:00" }),
	row({
		who: "Handoff Pre-section",
		detail: "introduces the section",
		time: "6:03",
		handoff: true,
		minutes: 0,
	}),
	row({ who: "SECTION TWO", time: "6:03", section: true, minutes: 0 }),
	row({ who: "Bravo Beat", detail: "bravo detail", time: "6:03" }),
	row({
		who: "Handoff First",
		detail: "first introduction",
		time: "6:06",
		handoff: true,
		minutes: 0,
	}),
	row({
		who: "Handoff Second",
		detail: "second introduction",
		time: "6:06",
		handoff: true,
		minutes: 0,
	}),
	row({ who: "Charlie Beat", detail: "charlie detail", time: "6:06" }),
	row({
		who: "Handoff Trailing",
		detail: "nothing follows",
		time: "6:09",
		handoff: true,
		minutes: 0,
	}),
];

function mountRows(
	layout: AgendaLayout,
	rows: TimelineRow[],
	density: PrintDensity,
) {
	return render(
		view(layout, { rows, initialDensity: density, roles: [], officers: [] }),
	).container;
}

const handoffEls = (c: HTMLElement) =>
	[...c.querySelectorAll<HTMLElement>("[data-row-handoff]")].map(
		(e) => e.textContent ?? "",
	);

describe("a hand-off folds into the beat it introduces", () => {
	for (const layout of AGENDA_LAYOUTS) {
		// protects=a hand-off prints as the first line INSIDE the next beat's block,
		//   consecutive ones in order, and one before a section or at the end keeps
		//   its band
		// fails_when=a hand-off stays a separate band, folds into the wrong beat,
		//   folds past a section, loses its text, or a folded one is dropped
		// no_claim=how tall the block is (Chrome measures that)
		it(`${layout}: folds into the next beat, not past a section or the end`, () => {
			const c = mountRows(layout, FOLD_ROWS, "compact");
			const blocks = [...c.querySelectorAll<HTMLElement>("[data-row-block]")];
			const blockOf = (time: string, who: string) =>
				blocks.find(
					(b) =>
						b.querySelector(`[data-row-time="${time}"]`) &&
						(b.textContent ?? "").includes(who),
				);
			const charlie = blockOf("6:06", "Charlie Beat");
			expect(charlie, "Charlie's block").toBeDefined();
			const inCharlie = [
				...(charlie?.querySelectorAll<HTMLElement>("[data-row-handoff]") ?? []),
			].map((e) => e.textContent ?? "");
			expect(inCharlie).toEqual([
				"Handoff First · first introduction",
				"Handoff Second · second introduction",
			]);
			// The block opens with them: the first line of the beat, not the last.
			const text = charlie?.textContent ?? "";
			expect(text.indexOf("Handoff First")).toBeLessThan(
				text.indexOf("Charlie Beat"),
			);
			// Beats that nothing folded into carry none.
			for (const [time, who] of [
				["6:00", "Alpha Beat"],
				["6:03", "Bravo Beat"],
			] as const)
				expect(
					blockOf(time, who)?.querySelectorAll("[data-row-handoff]").length,
					who,
				).toBe(0);
			// The two that cannot fold keep a band: their text is on the sheet and
			// inside no beat's block.
			for (const who of ["Handoff Pre-section", "Handoff Trailing"]) {
				expect(handoffEls(c).join("|"), who).not.toContain(who);
				expect(c.textContent, who).toContain(who);
				expect(
					blocks.some((b) => (b.textContent ?? "").includes(who)),
					`${who} is inside a beat's block`,
				).toBe(false);
			}
			// The #363 invariant: one clock stamp per row that is neither a hand-off
			// nor a section, and none for a hand-off (folded or not).
			expect(c.querySelectorAll("[data-row-time]")).toHaveLength(3);
		});

		// protects=regular still prints every hand-off as its own band
		// fails_when=the fold leaks into regular (the markup baseline covers MCF;
		//   this covers a section and a trailing hand-off, which MCF has neither of)
		// no_claim=compact
		it(`${layout}: regular keeps all four bands`, () => {
			const c = mountRows(layout, FOLD_ROWS, "regular");
			expect(c.querySelectorAll("[data-row-handoff]")).toHaveLength(0);
			expect(c.querySelectorAll("[data-row-block]")).toHaveLength(0);
			for (const who of [
				"Handoff Pre-section",
				"Handoff First",
				"Handoff Second",
				"Handoff Trailing",
			])
				expect(c.textContent, who).toContain(who);
			expect(c.querySelectorAll("[data-row-time]")).toHaveLength(3);
		});
	}

	// protects=the MCF agenda's hand-offs fold at compact on every layout, each
	//   inside a beat's block, with one stamp per non-hand-off row (#363)
	// fails_when=a real agenda's hand-off stays a band, or a stamp is lost or
	//   repeated by the fold
	// no_claim=the order of the rows, which the Chrome text test compares
	it("MCF: stamps equal the non-hand-off rows and every folded hand-off is in a block", () => {
		const beats = MCF_ROWS.filter((r) => !r.handoff && !r.section).length;
		for (const layout of AGENDA_LAYOUTS) {
			const c = render(view(layout, { initialDensity: "compact" })).container;
			expect(c.querySelectorAll("[data-row-time]"), layout).toHaveLength(beats);
			const folded = [...c.querySelectorAll("[data-row-handoff]")];
			expect(folded.length, layout).toBeGreaterThan(0);
			for (const h of folded)
				expect(
					h.closest("[data-row-block]"),
					`${layout} ${h.textContent}`,
				).not.toBeNull();
			cleanup();
		}
	});
});

describe("Editorial's compact run of show is full width", () => {
	const topColumns = (c: HTMLElement) =>
		c.querySelector<HTMLElement>('div[style*="gap: 22px"]');

	// protects=at compact the run of show leaves the 506px right column for a block
	//   under the two-column top (officers | meeting roles), and at regular it stays
	// fails_when=compact keeps the run of show beside the officers, or regular moves it
	// no_claim=how much height that saves (the Chrome tests measure it)
	it("moves the run of show out of the two-column top", () => {
		const regular = render(view("editorial")).container;
		const top = topColumns(regular);
		expect(top, "regular has the two-column top").not.toBeNull();
		expect(top?.querySelector("[data-row-time]")).not.toBeNull();
		const regularStamps = regular.querySelectorAll("[data-row-time]").length;
		cleanup();
		const compact = render(
			view("editorial", { initialDensity: "compact" }),
		).container;
		const compactTop = topColumns(compact);
		expect(compactTop, "compact keeps the two-column top").not.toBeNull();
		expect(compactTop?.textContent).toContain("Meeting Roles");
		expect(compactTop?.querySelector("[data-row-time]")).toBeNull();
		expect(compact.querySelectorAll("[data-row-time]").length).toBe(
			regularStamps,
		);
	});
});

describe("compact keeps a lead's detail on its title line", () => {
	const LEAD: TimelineRow[] = [
		row({
			who: "Lead Role · Name One",
			detail: "lead detail text",
			time: "7:00",
			marks: { green: 4, yellow: 5, red: 6 },
			roleKey: "lead",
		}),
		row({
			who: "Lead Role · Name One",
			detail: "second beat detail",
			time: "7:04",
			roleKey: "lead",
		}),
		row({
			who: "Panel · A One & B Two",
			detail: "panel detail text",
			time: "7:08",
			holders: ["A One", "B Two"],
			roleLabel: "Panel",
			roleKey: "panel",
		}),
	];

	for (const layout of ["editorial", "spacious"] as const) {
		// protects=compact puts the lead's detail after the title and marks on one
		//   line; a list of holders and a presenter group's later beats are unchanged
		// fails_when=the detail stays beneath the title, moves for a multi-holder
		//   row, or a continuation beat changes
		// no_claim=that the line fits (the text-equality test) or wraps well (Chrome)
		it(`${layout}: lead detail beside the title; holders and continuations unchanged`, () => {
			const regular = mountRows(layout, LEAD, "regular");
			const titleOf = (c: HTMLElement, time: string) =>
				c.querySelector(`[data-row-time="${time}"]`)?.nextElementSibling;
			expect(titleOf(regular, "7:00")?.textContent).not.toContain(
				"lead detail text",
			);
			cleanup();
			const compact = mountRows(layout, LEAD, "compact");
			const lead = compact.querySelector<HTMLElement>("[data-row-title]");
			expect(lead?.textContent).toContain("Lead Role · Name One");
			expect(lead?.textContent).toContain("4:00");
			expect(lead?.textContent).toMatch(/·\s*lead detail text$/);
			// The continuation beat keeps its own stamp and its detail beside it.
			const second = compact.querySelector(`[data-row-time="7:04"]`);
			expect(second?.nextElementSibling?.textContent).toBe(
				"second beat detail",
			);
			// A multi-holder row: the title is the role, the holders follow, then the
			// detail on a line of its own, outside the title.
			const titles = [...compact.querySelectorAll("[data-row-title]")];
			const panel = titles.find((t) => t.textContent?.includes("Panel"));
			expect(panel?.textContent).not.toContain("panel detail text");
			expect(compact.querySelectorAll("[data-row-holders]")).toHaveLength(1);
			expect(
				compact.querySelector("[data-row-holders]")?.textContent,
			).toContain("A One");
			expect(compact.textContent).toContain("panel detail text");
		});
	}
});

/**
 * The ladder, in jsdom with the sheets' measured height stubbed. `FitPage`
 * reads `scrollHeight` of its `[data-fit-inner]`; a sheet that would need a
 * scale under `MIN_FIT_SCALE` (3000px here) calls `onWouldFlow`, one that fits
 * (1000px) does not. The stub answers per density by looking for compact's
 * `data-row-block` anywhere in the document: the density belongs to the whole
 * layout, and a roster sheet carries no rows to look inside.
 */
describe("the density ladder", () => {
	function stubHeights(h: { regular: number; compact: number }) {
		return vi
			.spyOn(HTMLElement.prototype, "scrollHeight", "get")
			.mockImplementation(function (this: HTMLElement) {
				if (!this.hasAttribute("data-fit-inner")) return 0;
				return document.querySelector("[data-row-block]")
					? h.compact
					: h.regular;
			});
	}
	const isCompact = (c: HTMLElement) =>
		c.querySelector("[data-row-block]") !== null;

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		// protects=a sheet that would flow moves the whole layout to compact, once,
		//   and the caller is NOT told when compact fits
		// fails_when=the climb never happens (the `setDensity("compact")` branch is
		//   dead), the caller is told at regular, or the sheet does not re-measure
		// no_claim=a real agenda needs it (Chrome)
		it(`${layout}: climbs to compact when regular would flow, and says nothing when it fits`, () => {
			stubHeights({ regular: 3000, compact: 1000 });
			const told = vi.fn();
			const { container } = render(view(layout, { onWouldFlow: told }));
			expect(isCompact(container)).toBe(true);
			expect(told).not.toHaveBeenCalled();
		});

		// protects=an agenda that fits stays at regular and says nothing
		// fails_when=a sheet that fits is compacted, or the caller is told
		// no_claim=the boundary (print-fallback.test.tsx pins MIN_FIT_SCALE's edge)
		it(`${layout}: a sheet that fits never leaves regular`, () => {
			stubHeights({ regular: 1000, compact: 1000 });
			const told = vi.fn();
			const { container } = render(view(layout, { onWouldFlow: told }));
			expect(isCompact(container)).toBe(false);
			expect(told).not.toHaveBeenCalled();
		});

		// protects=compact that still flows hands the decision to the caller, in the
		//   layouts that have a fallback to hand it to; Timing IS the fallback, so a
		//   Timing sheet still too long at compact keeps today's flow and says nothing
		//   (otherwise the route announces a fallback "from Timing to Timing")
		// fails_when=the caller is never told at compact, or is told at regular, or
		//   (timing) the caller is told at compact, or Timing never climbs to compact
		// no_claim=what the route does with it (print-fallback.test.tsx)
		it(`${layout}: a sheet still flowing at compact ${layout === "timing" ? "does not tell the caller" : "tells the caller"}`, () => {
			stubHeights({ regular: 3000, compact: 3000 });
			const told = vi.fn();
			const { container } = render(view(layout, { onWouldFlow: told }));
			expect(isCompact(container)).toBe(true);
			if (layout === "timing") expect(told).not.toHaveBeenCalled();
			else expect(told).toHaveBeenCalled();
		});
	}

	// protects=every sheet of a two-sheet layout prints at the same density
	// fails_when=only the sheet that flowed is compacted (the roster page stays
	//   regular beside a compact run of show)
	// no_claim=that sheet one needed it
	it("spacious: the whole layout compacts when only page 2 would flow", () => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				if (!this.hasAttribute("data-fit-inner")) return 0;
				// Only the run-of-show sheet is too long, and only at regular.
				const runSheet = this.querySelector("[data-row-time]") !== null;
				if (!runSheet || document.querySelector("[data-row-block]"))
					return 1000;
				return 3000;
			},
		);
		const { container } = render(view("spacious"));
		// Both sheets remounted at the new density: the run of show is compact, and
		// the sheet count is still two.
		expect(isCompact(container)).toBe(true);
		expect(container.querySelectorAll("[data-fit-inner]")).toHaveLength(2);
	});

	// protects=a new agenda, or a new layout, climbs again from regular and re-measures
	// fails_when=the density outlives the agenda or the layout it was decided for, or
	//   a new agenda at the SAME density is not measured (the sheet is not remounted)
	// no_claim=that the route calls this with a stable `rows` (it rebuilds them per render)
	it("a new rows array returns to regular", () => {
		const spy = stubHeights({ regular: 3000, compact: 1000 });
		const { container, rerender } = render(view("grid"));
		expect(isCompact(container)).toBe(true);
		// The next agenda fits at regular.
		spy.mockImplementation(function (this: HTMLElement) {
			return this.hasAttribute("data-fit-inner") ? 1000 : 0;
		});
		rerender(view("grid", { rows: [...MCF_ROWS] }));
		expect(isCompact(container)).toBe(false);
	});

	// protects=a layout switch climbs again from regular: the density decided for
	//   Grid is not carried into Editorial
	// fails_when=the density outlives the layout it was decided for (the switch does
	//   not reset it), so Editorial opens compact although it fits at regular
	// no_claim=that Editorial is remeasured (the layout's own component remounts it)
	it("a new layout returns to regular", () => {
		const spy = stubHeights({ regular: 3000, compact: 1000 });
		const { container, rerender } = render(view("grid"));
		expect(isCompact(container)).toBe(true);
		spy.mockImplementation(function (this: HTMLElement) {
			return this.hasAttribute("data-fit-inner") ? 1000 : 0;
		});
		rerender(view("editorial"));
		expect(isCompact(container)).toBe(false);
	});

	// protects=the reset measures the new agenda: a sheet that fit at regular, then
	//   a new agenda that flows, climbs again
	// fails_when=the sheet keeps its old (fit) measurement and never climbs
	// no_claim=the layout switch above, which remounts by component type anyway
	it("a new rows array at regular is measured again and can climb", () => {
		const spy = stubHeights({ regular: 1000, compact: 1000 });
		const { container, rerender } = render(view("grid"));
		expect(isCompact(container)).toBe(false);
		spy.mockImplementation(function (this: HTMLElement) {
			if (!this.hasAttribute("data-fit-inner")) return 0;
			return document.querySelector("[data-row-block]") ? 1000 : 3000;
		});
		rerender(view("grid", { rows: [...MCF_ROWS] }));
		expect(isCompact(container)).toBe(true);
	});
});

const hasChrome = findChrome() !== null;

describe("print compact harness availability", () => {
	// protects=a CI run cannot go green with the Chrome scenarios silently skipped
	// fails_when=CI is set and no browser is found (the suite below skips whole)
	// no_claim=that the browser found is the right version, or that a local run has one
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every compact measurement would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

const SCENARIOS: CompactScenario[] = [];
const sc = (
	kind: CompactScenario["kind"],
	fixture: PrintCompactFixtureId,
	layout: AgendaLayout,
) =>
	SCENARIOS.push({ id: `${kind}:${fixture}:${layout}`, fixture, layout, kind });
for (const layout of AGENDA_LAYOUTS) {
	sc("climb", "thrLong", layout);
	sc("climb", "mcf", layout);
	sc("climb", CONTEST, layout);
	for (const fixture of ["thrLong", "contest7", CONTEST] as const)
		sc("text", fixture, layout);
}

let results: Record<string, ClimbSnapshot | TextSnapshot> = {};
const climb = (fixture: PrintCompactFixtureId, layout: AgendaLayout) =>
	results[`climb:${fixture}:${layout}`] as ClimbSnapshot;
const text = (fixture: PrintCompactFixtureId, layout: AgendaLayout) =>
	results[`text:${fixture}:${layout}`] as TextSnapshot;
const nat = (s: ClimbSnapshot) =>
	`calls=${s.calls} compact=${s.compact} sheets=${JSON.stringify(s.sheets)}`;

/** Collapse whitespace and case: innerText honours `text-transform`, and the
 *  section bands are uppercase on paper. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe.skipIf(!hasChrome)(
	"compact in Chrome, FitPage's real effect",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		beforeAll(async () => {
			results = await runClientEntry<typeof results>(
				"src/test/print-compact-entry.tsx",
				PRINT_PAGE_CSS,
				{ scenarios: SCENARIOS },
			);
		}, 120_000);

		// protects=the overflow fixture really flows at regular on this machine, and
		//   an agenda that fits does not climb (so "compact" below is a decision)
		// fails_when=thrAgendaLong stops crossing the cliff, or MCF starts to climb
		// no_claim=anything about compact's size
		it("control: thrAgendaLong climbs in Grid, Editorial and Spacious; MCF never does", () => {
			for (const layout of ["grid", "editorial", "spacious"] as const)
				expect(climb("thrLong", layout).compact, layout).toBe(true);
			for (const layout of AGENDA_LAYOUTS) {
				const s = climb("mcf", layout);
				expect(s.compact, `mcf ${layout} ${nat(s)}`).toBe(false);
				expect(s.calls, `mcf ${layout} ${nat(s)}`).toBe(0);
			}
		});

		// protects=a long agenda keeps the layout the club chose: its own sheet count
		//   at compact, no Timing fallback, and a scale a person can read
		// fails_when=a layout still flows at compact (the caller is told), ends on a
		//   sheet that is not exactly one page tall, or needs a scale under MIN_FIT_SCALE
		// no_claim=that Linux CI's face agrees (its heights are shorter, so it errs
		//   toward fitting); every message carries the numbers this machine saw
		for (const layout of ["grid", "editorial", "spacious"] as const) {
			it(`${layout} on thrAgendaLong fits ${AGENDA_LAYOUT_PAGES[layout]} sheet(s) at compact`, () => {
				const s = climb("thrLong", layout);
				expect(s.compact, `${layout} ${nat(s)}`).toBe(true);
				expect(s.calls, `${layout} ${nat(s)}`).toBe(0);
				expect(
					s.sheets.map((x) => x.height),
					`${layout} ${nat(s)}`,
				).toEqual(
					Array.from({ length: AGENDA_LAYOUT_PAGES[layout] }, () => PAGE_H),
				);
				for (const sheet of s.sheets)
					expect(sheet.scale, `${layout} ${nat(s)}`).toBeGreaterThanOrEqual(
						MIN_FIT_SCALE,
					);
			});
		}

		// protects=compact Editorial's body text still prints large enough to read
		// fails_when=the printed detail size, measured as print-density.test.tsx
		//   measures it (declared size x the scale FitPage applies), falls under
		//   EDITORIAL_MIN_PRINTED_PT
		// no_claim=Editorial on an agenda that fits (print-density.test.tsx)
		it("compact Editorial on thrAgendaLong prints its detail at or above the floor", () => {
			const s = climb("thrLong", "editorial");
			expect(s.sheets, nat(s)).toHaveLength(1);
			const { scale } = s.sheets[0];
			const pt = pxToPt(RUN_NARRATIVE_TYPE.sm.detail * scale);
			expect(s.compact, nat(s)).toBe(true);
			expect(pt, `printed detail ${pt}pt ${nat(s)}`).toBeGreaterThanOrEqual(
				EDITORIAL_MIN_PRINTED_PT,
			);
		});

		// protects=a contest long enough to overflow compact climbs the whole ladder
		//   and reaches the caller, which is what makes the route show Timing
		// fails_when=a layout flows at compact without telling the caller, or never
		//   tries compact first
		// no_claim=that Timing then fits (#1227). The issue names a SEVEN-contestant
		//   fixture; no contest fixture at seven overflows compact in all three
		//   layouts here (contestFixture(7) fits regular, the dense template at
		//   seven fits compact), so this one seats sixteen
		for (const layout of ["grid", "editorial", "spacious"] as const) {
			it(`${layout} on a sixteen-contestant contest climbs to compact and then tells the caller`, () => {
				const s = climb(CONTEST, layout);
				expect(s.compact, `${layout} ${nat(s)}`).toBe(true);
				expect(s.calls, `${layout} ${nat(s)}`).toBeGreaterThan(0);
			});
		}

		/** Every needle of every row (`who`, `detail`, `time`), in row order. */
		const needlesOf = (rows: TimelineRow[]) =>
			rows.flatMap((r, i) =>
				(["time", "who", "detail"] as const)
					.map((k) => ({ i, k, s: norm(r[k] ?? "") }))
					.filter((n) => n.s !== ""),
			);
		const occurrences = (hay: string, needle: string) => {
			const out: number[] = [];
			for (
				let at = hay.indexOf(needle);
				at !== -1;
				at = hay.indexOf(needle, at + 1)
			)
				out.push(at);
			return out;
		};

		// protects=compact loses no text and duplicates none: for every row, in row
		//   order, each of its who, detail and time occurs as often as at regular, and
		//   the strings appear in the same relative order
		// fails_when=a hand-off or a detail is dropped, printed twice, or moved
		//   across another row's text
		// no_claim=that the strings are readable (type size is the density test's), or
		//   case: innerText follows text-transform, so both sides are lower-cased
		for (const fixture of ["thrLong", "contest7", CONTEST] as const) {
			for (const layout of AGENDA_LAYOUTS) {
				it(`${fixture} ${layout}: the same strings, as often, in the same order`, () => {
					const { rows } = printCompactAgenda(fixture);
					const t = text(fixture, layout);
					const regular = norm(t.regular.join(" "));
					const compact = norm(t.compact.join(" "));
					expect(regular.length, "regular text is empty").toBeGreaterThan(500);
					expect(compact.length, "compact text is empty").toBeGreaterThan(500);
					const needles = needlesOf(rows);
					expect(needles.length).toBeGreaterThan(rows.length);
					// Counts, per distinct string.
					for (const s of new Set(needles.map((n) => n.s)))
						expect(
							occurrences(compact, s).length,
							`"${s}" at compact vs regular`,
						).toBe(occurrences(regular, s).length);
					// Order: the sequence of (row, field) labels sorted by where each
					// occurrence sits.
					const sequence = (hay: string) =>
						needles
							.flatMap((n) =>
								occurrences(hay, n.s).map((at) => ({
									at,
									label: `${n.i}:${n.k}`,
								})),
							)
							.sort((a, b) => a.at - b.at || a.label.localeCompare(b.label))
							.map((o) => o.label);
					expect(sequence(compact)).toEqual(sequence(regular));
				});
			}
		}

		// protects=the text test cannot pass vacuously: compact really read a compact
		//   render, which differs from regular
		// fails_when=initialDensity is ignored by the entry, so both reads are regular
		// no_claim=which strings differ (none should: see above)
		it("the compact read is a different render from the regular one", () => {
			const t = text("thrLong", "editorial");
			expect(norm(t.compact.join(" "))).not.toBe(norm(t.regular.join(" ")));
		});
	},
);
