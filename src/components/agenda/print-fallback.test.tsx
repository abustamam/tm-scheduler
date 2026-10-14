// @vitest-environment jsdom
/**
 * A one-sheet agenda that cannot fit switches to Timing instead of printing on a
 * second page (#1225).
 *
 * `FitPage` scales a sheet to fit, and once the scale it needs drops under
 * `MIN_FIT_SCALE` it lets the sheet FLOW onto extra pages. A club that picked
 * "Grid, 1 page" printed two, and nothing said so. A sheet that is about to flow
 * now tells its caller (`onWouldFlow`), and the print route renders Timing for
 * that render.
 *
 * TWO layers, and only the second can see the bug:
 *
 *   · jsdom, with `scrollHeight` stubbed: `FitPage` calls `onWouldFlow` exactly
 *     when it flows. That is the wiring; it cannot say a real agenda flows.
 *   · Chrome, with `FitPage`'s REAL measuring effect (a client React root, after
 *     fonts load): the THR fixture's Grid, Editorial and Spacious really flow on
 *     the base code (the `bare` control below measures that, and a fixture that
 *     does not flow would make every other assertion here vacuous), and through
 *     `PrintAgendaView` they end on Timing's two 1056px sheets. `renderToStaticMarkup`
 *     never runs that effect, which is how #1179 passed and #1181 shipped.
 *
 * Harness: `src/test/client-bundle-chrome.ts` bundles
 * `src/test/print-fallback-entry.tsx`, which runs every scenario in ONE launch.
 * Same caveat as every browser-backed suite here: no webfont resolves, so the
 * heights are this machine's fallback face's, not the deployed page's.
 *
 * AC 0 (measured on `main`, this harness, macOS `chrome-headless-shell`): THR as
 * it stands already crosses the cliff `(1056 - 2) / 0.72 = 1464px` in all three
 * layouts, so no longer variant of the fixture was needed. Natural sheet height:
 * grid 1565, editorial 1478, spacious page 2 1744, Timing page 2 1249 (fits, on
 * two sheets). MCF fits every layout: grid 1343, editorial 1175, spacious page 2
 * 1345, Timing 1056.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AGENDA_LAYOUT_LABELS,
	AGENDA_LAYOUT_PAGES,
	AGENDA_LAYOUTS,
} from "#/lib/agenda-layouts";
import { runClientEntry } from "#/test/client-bundle-chrome";
import type { Scenario, Snapshot } from "#/test/print-fallback-entry";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
import type { AgendaLayout } from "./meeting-agenda-print";
import { FitPage, MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

afterEach(cleanup);

describe("FitPage onWouldFlow", () => {
	/** Mount FitPage whose inner element reports `height` px of content. */
	function mountWith(height: number, onWouldFlow?: () => void) {
		const spy = vi
			.spyOn(HTMLElement.prototype, "scrollHeight", "get")
			.mockReturnValue(height);
		const ui = (cb?: () => void) => (
			<FitPage onWouldFlow={cb}>
				<p>run of show</p>
			</FitPage>
		);
		const view = render(ui(onWouldFlow));
		return {
			view,
			rerender: (cb?: () => void) => view.rerender(ui(cb)),
			done: () => spy.mockRestore(),
		};
	}

	// protects=the caller is told when a sheet flows, once, whatever re-renders follow
	// fails_when=the call is missing, repeats per render, or reads a stale callback
	// no_claim=a real agenda flows (the Chrome scenarios below measure that)
	it("calls it once, with the latest callback, when the scale needed is under the floor", () => {
		const first = vi.fn();
		const latest = vi.fn();
		// (1056 - 2) / 3000 = 0.35, far under MIN_FIT_SCALE.
		const m = mountWith(3000, first);
		try {
			expect(first).toHaveBeenCalledTimes(1);
			m.rerender(latest);
			m.rerender(latest);
			// The sheet already flows: one decision per mount, however it re-renders.
			expect(first).toHaveBeenCalledTimes(1);
			expect(latest).not.toHaveBeenCalled();
			expect(
				m.view.container.querySelector<HTMLElement>(".agenda-page")?.style
					.height,
			).toBe("");
		} finally {
			m.done();
		}
	});

	// protects=a sheet that scales or fits never raises the alarm
	// fails_when=the call moves out of the flow branch, or fires for any overrun
	// no_claim=the boundary value itself: 0.72 is `MIN_FIT_SCALE`'s, pinned in print-theme.test.tsx
	it("never calls it when the sheet fits or scales", () => {
		const cb = vi.fn();
		// Just over the cliff's other side: scale = (1056 - 2) / h >= MIN_FIT_SCALE.
		const justScalable = Math.floor((PAGE_H - 2) / MIN_FIT_SCALE);
		for (const h of [PAGE_H - 100, Math.round(PAGE_H * 1.1), justScalable]) {
			const m = mountWith(h, cb);
			m.done();
			cleanup();
		}
		expect(cb).not.toHaveBeenCalled();
	});

	// protects=every FitPage consumer without the prop keeps flowing, silently
	// fails_when=the call is made unguarded and throws
	// no_claim=the print routes other than the agenda's, which this file does not render
	it("still flows with no callback", () => {
		const m = mountWith(3000);
		try {
			const sheet = m.view.container.querySelector<HTMLElement>(".agenda-page");
			expect(sheet?.style.height).toBe("");
		} finally {
			m.done();
		}
	});
});

const hasChrome = findChrome() !== null;

describe("print fallback harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every fallback measurement would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

const SCENARIOS: Scenario[] = [];
let results: Record<string, Snapshot[]> = {};

const sc = (
	id: string,
	fixture: Scenario["fixture"],
	layout: AgendaLayout,
	rest: Partial<Pick<Scenario, "steps" | "mode">> & {
		copies?: number;
		duplex?: 1;
		chrome?: "none";
	} = {},
) => {
	const { steps, mode, ...search } = rest;
	SCENARIOS.push({
		id,
		fixture,
		search: { layout, ...search },
		mode: mode ?? "view",
		steps: steps ?? [],
	});
};

for (const layout of AGENDA_LAYOUTS) {
	sc(`thr:${layout}`, "thr", layout);
	sc(`thr:${layout}:bare`, "thr", layout, { mode: "bare" });
	sc(`mcf:${layout}`, "mcf", layout);
	sc(`mcf:${layout}:bare`, "mcf", layout, { mode: "bare" });
}
sc("thr:grid:copies", "thr", "grid", { copies: 3, duplex: 1 });
sc("thr:grid:chrome-none", "thr", "grid", { chrome: "none" });
sc("thr:grid:tabs", "thr", "grid", {
	steps: [
		{ kind: "tab", layout: "editorial" },
		{ kind: "tab", layout: "grid" },
	],
});
sc("thr:grid:via-timing", "thr", "grid", {
	steps: [
		{ kind: "tab", layout: "timing" },
		{ kind: "tab", layout: "grid" },
	],
});
sc("thr:grid:new-agenda", "thr", "grid", {
	steps: [{ kind: "fixture", fixture: "mcf" }],
});

const first = (id: string): Snapshot => {
	const s = results[id]?.[0];
	if (!s) throw new Error(`no snapshot for ${id}`);
	return s;
};
const at = (id: string, i: number): Snapshot => {
	const s = results[id]?.[i];
	if (!s) throw new Error(`no snapshot ${i} for ${id}`);
	return s;
};

const NOTICE: Record<"grid" | "editorial", string> = {
	grid: "This agenda is too long for Grid on 1 page. Showing Timing (2 pages) instead.",
	editorial:
		"This agenda is too long for Editorial on 1 page. Showing Timing (2 pages) instead.",
};

describe.skipIf(!hasChrome)(
	"print fallback, FitPage's real effect in Chrome",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		beforeAll(async () => {
			results = await runClientEntry<Record<string, Snapshot[]>>(
				"src/test/print-fallback-entry.tsx",
				PRINT_PAGE_CSS,
				{ scenarios: SCENARIOS },
				{
					"#/server/meetings": "src/test/print-route-server-stubs.ts",
					"#/server/club-logo": "src/test/print-route-server-stubs.ts",
					"#/lib/club-route": "src/test/print-route-server-stubs.ts",
				},
			);
		}, 120_000);

		// protects=the fixture used below really flows on the code as it stood
		// fails_when=THR stops crossing the cliff (a fixture or layout change), which
		//   would turn every fallback assertion into a pass about nothing
		// no_claim=anything about the fallback; this renders `MeetingAgendaPrint` alone
		it("control: the THR fixture flows in Grid, Editorial and Spacious with no fallback", () => {
			const cliff = (PAGE_H - 2) / MIN_FIT_SCALE;
			for (const layout of ["grid", "editorial", "spacious"] as const) {
				const tallest = Math.max(...first(`thr:${layout}:bare`).pages);
				expect(tallest, layout).toBeGreaterThan(cliff);
			}
			// ... and Timing is the one that holds it on two sheets.
			expect(first("thr:timing:bare").pages).toEqual([PAGE_H, PAGE_H]);
		});

		// protects=a one-sheet or Spacious layout that would flow ends on Timing's two sheets
		// fails_when=it flows to 2+ printed pages, stays on the requested layout, or ends
		//   on a sheet that is not exactly one page tall
		// no_claim=Timing's own overflow (#1227), or the printed PDF's page count
		for (const layout of ["grid", "editorial", "spacious"] as const) {
			it(`${layout} on the THR fixture falls back to two 1056px Timing sheets`, () => {
				const s = first(`thr:${layout}`);
				expect(s.pages).toEqual([PAGE_H, PAGE_H]);
				expect(s.timing).toBe(true);
				expect(s.blanks).toBe(0);
				// The tab the person picked stays the active one.
				expect(s.activeTab).toBe(AGENDA_LAYOUT_LABELS[layout]);
			});
		}

		// protects=the notice's exact words, shown only after a fallback
		// fails_when=the words drift, name the wrong layout or page count, or show
		//   when nothing fell back (Timing asked for, or an agenda that fits)
		// no_claim=how the line looks in the toolbar at narrow widths
		it("says why, in the specified words", () => {
			expect(first("thr:grid").notice).toBe(NOTICE.grid);
			expect(first("thr:editorial").notice).toBe(NOTICE.editorial);
			expect(first("thr:spacious").notice).toBe(
				"This agenda is too long for Spacious on 2 pages. Showing Timing (2 pages) instead.",
			);
		});

		it("shows no notice when nothing fell back", () => {
			expect(first("thr:timing").notice).toBeNull();
			expect(first("thr:timing").pages).toEqual([PAGE_H, PAGE_H]);
			for (const layout of AGENDA_LAYOUTS) {
				expect(first(`mcf:${layout}`).notice, layout).toBeNull();
			}
		});

		// protects=an agenda that fits renders exactly as before
		// fails_when=a fallback, a notice, or a different sheet count or height appears
		//   for MCF, which fits every layout
		// no_claim=THR-length agendas (above)
		for (const layout of AGENDA_LAYOUTS) {
			it(`${layout} on the MCF fixture is unchanged`, () => {
				const s = first(`mcf:${layout}`);
				expect(s.notice).toBeNull();
				expect(s.pages).toEqual(first(`mcf:${layout}:bare`).pages);
				expect(s.pages).toEqual(
					Array.from({ length: AGENDA_LAYOUT_PAGES[layout] }, () => PAGE_H),
				);
				expect(s.timing).toBe(layout === "timing");
			});
		}

		// protects=the fallback leaves a duplex run of copies with no blank sheets
		// fails_when=the copies count Grid's one sheet (odd), padding blanks between
		//   Timing's two-sheet copies
		// no_claim=the packet PDF, which is built by a different route
		it("copies=3 duplex on the THR grid is 3 copies of 2 sheets and no blanks", () => {
			const s = first("thr:grid:copies");
			expect(s.pages).toEqual(Array.from({ length: 6 }, () => PAGE_H));
			expect(s.blanks).toBe(0);
			expect(s.timing).toBe(true);
		});

		// protects=chrome=none (no toolbar) switches silently
		// fails_when=the notice renders without a toolbar, or the bare view still flows
		// no_claim=the toolbar of the full view, covered above
		it("chrome=none falls back with no notice", () => {
			const s = first("thr:grid:chrome-none");
			expect(s.pages).toEqual([PAGE_H, PAGE_H]);
			expect(s.timing).toBe(true);
			expect(s.notice).toBeNull();
		});

		// protects=a tab switch away and back measures the requested layout again
		// fails_when=the fallback outlives the layout it was decided for: Grid goes
		//   straight to Timing without ever being drawn or measured again
		// no_claim=that the second measurement agrees with the first (same agenda)
		it("a tab switch away and back re-measures the layout", () => {
			const id = "thr:grid:tabs";
			expect(at(id, 0).notice).toBe(NOTICE.grid);
			// Editorial is measured on its own and falls back on its own.
			expect(at(id, 1).notice).toBe(NOTICE.editorial);
			expect(at(id, 1).activeTab).toBe("Editorial");
			expect(at(id, 2).notice).toBe(NOTICE.grid);
			expect(at(id, 2).reads).toBeGreaterThan(0);
			expect(at(id, 2).pages).toEqual([PAGE_H, PAGE_H]);
		});

		it("returning to a layout after Timing measures it again, not remembers the fallback", () => {
			const id = "thr:grid:via-timing";
			// Timing is its own layout: no notice, and nothing to measure again.
			expect(at(id, 1).notice).toBeNull();
			expect(at(id, 1).activeTab).toBe("Timing");
			expect(at(id, 1).reads).toBe(0);
			// Back on Grid: it is mounted and measured afresh (then falls back again).
			expect(at(id, 2).reads).toBeGreaterThan(0);
			expect(at(id, 2).notice).toBe(NOTICE.grid);
			expect(at(id, 2).pages).toEqual([PAGE_H, PAGE_H]);
		});

		// protects=a new agenda does not inherit the old one's fallback
		// fails_when=a short agenda that fits Grid stays on Timing because the
		//   previous (long) one fell back
		// no_claim=how the loader hands over new data (a router concern)
		it("new agenda data drops the fallback", () => {
			const id = "thr:grid:new-agenda";
			expect(at(id, 0).timing).toBe(true);
			const after = at(id, 1);
			expect(after.timing).toBe(false);
			expect(after.notice).toBeNull();
			expect(after.pages).toEqual([PAGE_H]);
		});
	},
);
