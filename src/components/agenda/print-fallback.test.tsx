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
 *     fonts load): `thrAgendaLong`'s Grid, Editorial and Spacious really flow on
 *     the base code (the `bare` control below measures that, and a fixture that
 *     does not flow would make every other assertion here vacuous), and through
 *     `PrintAgendaView` they end on Timing's two 1056px sheets. `renderToStaticMarkup`
 *     never runs that effect, which is how #1179 passed and #1181 shipped.
 *
 * Harness: `src/test/client-bundle-chrome.ts` bundles
 * `src/test/print-fallback-entry.tsx`, which runs every scenario in ONE launch.
 * Same caveat as every browser-backed suite here: no webfont resolves, so the
 * heights are this machine's fallback face's, not the deployed page's. CI (Linux)
 * pins a DIFFERENT fallback face from a Mac, so the same markup measures
 * differently there; every geometry assertion below carries the measured natural
 * height in its message so a failure on either machine says what it saw.
 *
 * AC 0, measured in this harness (cliff = `(1056 - 2) / 0.72 = 1464px`, natural
 * `[data-fit-inner].scrollHeight` of the tallest sheet):
 *
 *   fixture      grid  editorial  spacious p2  timing p2   Timing sheets
 *   THR (macOS)  1565  1478       1744         1249        1056 + 1056
 *   THR (Linux)  Editorial FITS on CI's pinned face (under 1464), Grid and
 *                Spacious flowed; run 38616788625 failed on it.
 *   thrAgendaLong (macOS)
 *                1729  1649       1903         1317        1056 + 1056
 *
 * So plain THR is not a safe control: Editorial crosses the cliff on a Mac and
 * fits on Linux. `thrAgendaLong` (a 4th speaker/evaluator pair and 3 more roster
 * roles) crosses it in all three layouts by 185px or more on a Mac and still
 * fits Timing on two sheets (Timing's own overflow is #1227). MCF fits every
 * layout: grid 1343, editorial 1175, spacious page 2 1345, Timing 1056.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AGENDA_LAYOUT_LABELS,
	AGENDA_LAYOUT_PAGES,
	AGENDA_LAYOUTS,
} from "#/lib/agenda-layouts";
import { runClientEntry } from "#/test/client-bundle-chrome";
import type {
	Scenario,
	ScenarioSearch,
	Snapshot,
} from "#/test/print-fallback-entry";
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
	// protects=a CI run cannot go green with the Chrome scenarios silently skipped
	// fails_when=CI is set and no browser is found (the suite below skips whole)
	// no_claim=that the browser found is the right version, or that a local run has one
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
	rest: Partial<Pick<Scenario, "steps" | "mode">> &
		Omit<ScenarioSearch, "layout"> = {},
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
	// Plain THR only reports: it flows on a Mac's fallback face and Editorial fits
	// on CI's, so nothing may assert that it flows. Its heights go in messages.
	sc(`thr:${layout}:bare`, "thr", layout, { mode: "bare" });
	sc(`long:${layout}`, "thrLong", layout);
	sc(`long:${layout}:bare`, "thrLong", layout, { mode: "bare" });
	sc(`mcf:${layout}`, "mcf", layout);
	sc(`mcf:${layout}:bare`, "mcf", layout, { mode: "bare" });
}
sc("long:grid:copies", "thrLong", "grid", { copies: 3, duplex: 1 });
sc("long:grid:chrome-none", "thrLong", "grid", { chrome: "none" });
// Editorial's fallback OVERWRITES `fellBackFrom` (grid -> editorial), so this
// path comes back to Grid whether or not the reset effect runs.
sc("long:grid:via-editorial", "thrLong", "grid", {
	steps: [
		{ kind: "tab", layout: "editorial" },
		{ kind: "tab", layout: "grid" },
	],
});
// Timing never falls back, so `fellBackFrom` is only cleared by the reset effect.
sc("long:grid:via-timing", "thrLong", "grid", {
	steps: [
		{ kind: "tab", layout: "timing" },
		{ kind: "tab", layout: "grid" },
	],
});
sc("long:grid:new-agenda", "thrLong", "grid", {
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

const NOTICE: Record<"grid" | "editorial" | "spacious", string> = {
	grid: "This agenda is too long for Grid on 1 page. Showing Timing (2 pages) instead.",
	editorial:
		"This agenda is too long for Editorial on 1 page. Showing Timing (2 pages) instead.",
	spacious:
		"This agenda is too long for Spacious on 2 pages. Showing Timing (2 pages) instead.",
};

/** What a failing assertion should say: the natural heights this machine's face
 *  gave, so a Linux CI failure reports Linux numbers. */
const nat = (s: Snapshot) => `natural=[${s.natural.join(", ")}]`;

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

		// protects=the fixture used below really flows on the code as it stood, on THIS
		//   machine's fallback face, and Timing is what holds it
		// fails_when=thrAgendaLong stops crossing the cliff (a fixture or layout change,
		//   or a different face), which would turn every fallback assertion into a pass
		//   about nothing; or Timing no longer holds it on two 1056px sheets
		// no_claim=anything about the fallback; this renders `MeetingAgendaPrint` alone.
		//   Plain THR's heights ride in the message only: Editorial fits on Linux CI
		it("control: thrAgendaLong flows in Grid, Editorial and Spacious with no fallback", () => {
			const cliff = (PAGE_H - 2) / MIN_FIT_SCALE;
			for (const layout of ["grid", "editorial", "spacious"] as const) {
				const s = first(`long:${layout}:bare`);
				const tallest = Math.max(...s.natural);
				expect(
					tallest,
					`${layout} natural=${tallest} cliff=${cliff} (plain THR ${nat(first(`thr:${layout}:bare`))})`,
				).toBeGreaterThan(cliff);
			}
			// ... and Timing is the one that holds it on two sheets, each under the cliff.
			const timing = first("long:timing:bare");
			const timingTallest = Math.max(...timing.natural);
			expect(timing.pages, `timing ${nat(timing)}`).toEqual([PAGE_H, PAGE_H]);
			expect(
				timingTallest,
				`timing natural=${timingTallest} cliff=${cliff}`,
			).toBeLessThan(cliff);
		});

		// protects=the layout attribution of a measurement, which AC 8's counts rest on
		// fails_when=a sheet's read is filed under another layout's key, or a layout is
		//   never measured at all (its key is missing)
		// no_claim=how many times a sheet is read per measurement (AC 8 pins that)
		it("bare: a measurement lands only under its own layout", () => {
			for (const fixture of ["long", "mcf"]) {
				for (const layout of AGENDA_LAYOUTS) {
					const s = first(`${fixture}:${layout}:bare`);
					expect(
						Object.keys(s.reads),
						`${fixture} ${layout} reads=${JSON.stringify(s.reads)}`,
					).toEqual([layout]);
					expect(s.reads[layout], `${fixture} ${layout}`).toBeGreaterThan(0);
				}
			}
		});

		// protects=a one-sheet or Spacious layout that would flow ends on Timing's two sheets
		// fails_when=it flows to 2+ printed pages, stays on the requested layout, or ends
		//   on a sheet that is not exactly one page tall
		// no_claim=Timing's own overflow (#1227), or the printed PDF's page count
		for (const layout of ["grid", "editorial", "spacious"] as const) {
			it(`${layout} on thrAgendaLong falls back to two 1056px Timing sheets`, () => {
				const s = first(`long:${layout}`);
				expect(s.pages, `${layout} ${nat(s)}`).toEqual([PAGE_H, PAGE_H]);
				expect(s.timing, `${layout} ${nat(s)}`).toBe(true);
				expect(s.blanks, `${layout} ${nat(s)}`).toBe(0);
				// The tab the person picked stays the active one.
				expect(s.activeTab, `${layout} ${nat(s)}`).toBe(
					AGENDA_LAYOUT_LABELS[layout],
				);
			});
		}

		// protects=the notice's exact words, shown only after a fallback
		// fails_when=the words drift, name the wrong layout or page count
		// no_claim=how the line looks in the toolbar at narrow widths
		it("says why, in the specified words", () => {
			for (const layout of ["grid", "editorial", "spacious"] as const) {
				const s = first(`long:${layout}`);
				expect(s.notice, `${layout} ${nat(s)}`).toBe(NOTICE[layout]);
			}
		});

		// protects=no notice when nothing fell back: Timing asked for, or an agenda that fits
		// fails_when=the notice shows for Timing (which has nowhere to fall back to) or
		//   for MCF, which fits every layout
		// no_claim=that the notice is absent after a fallback was reset (the tab and
		//   new-agenda scenarios below)
		it("shows no notice when nothing fell back", () => {
			const timing = first("long:timing");
			expect(timing.notice, `timing ${nat(timing)}`).toBeNull();
			expect(timing.pages, `timing ${nat(timing)}`).toEqual([PAGE_H, PAGE_H]);
			for (const layout of AGENDA_LAYOUTS) {
				const s = first(`mcf:${layout}`);
				expect(s.notice, `${layout} ${nat(s)}`).toBeNull();
			}
		});

		// protects=an agenda that fits renders exactly as before
		// fails_when=a fallback, a notice, or a different sheet count or height appears
		//   for MCF, which fits every layout
		// no_claim=long agendas (above)
		for (const layout of AGENDA_LAYOUTS) {
			it(`${layout} on the MCF fixture is unchanged`, () => {
				const s = first(`mcf:${layout}`);
				expect(s.notice, `${layout} ${nat(s)}`).toBeNull();
				expect(s.pages, `${layout} ${nat(s)}`).toEqual(
					first(`mcf:${layout}:bare`).pages,
				);
				expect(s.pages, `${layout} ${nat(s)}`).toEqual(
					Array.from({ length: AGENDA_LAYOUT_PAGES[layout] }, () => PAGE_H),
				);
				expect(s.timing, `${layout} ${nat(s)}`).toBe(layout === "timing");
			});
		}

		// protects=the fallback leaves a duplex run of copies with no blank sheets
		// fails_when=the copies count Grid's one sheet (odd), padding blanks between
		//   Timing's two-sheet copies
		// no_claim=the packet PDF, which is built by a different route
		it("copies=3 duplex on the long grid is 3 copies of 2 sheets and no blanks", () => {
			const s = first("long:grid:copies");
			expect(s.pages, nat(s)).toEqual(Array.from({ length: 6 }, () => PAGE_H));
			expect(s.blanks, nat(s)).toBe(0);
			expect(s.timing, nat(s)).toBe(true);
		});

		// protects=chrome=none (no toolbar) switches silently
		// fails_when=the notice renders without a toolbar, or the bare view still flows
		// no_claim=the toolbar of the full view, covered above
		it("chrome=none falls back with no notice", () => {
			const s = first("long:grid:chrome-none");
			expect(s.pages, nat(s)).toEqual([PAGE_H, PAGE_H]);
			expect(s.timing, nat(s)).toBe(true);
			expect(s.notice, nat(s)).toBeNull();
		});

		// protects=a tab switch away and back measures the requested layout again (AC 8)
		// fails_when=Grid is not mounted and measured exactly once on return, or Editorial
		//   is not measured on its own
		// no_claim=that the reset effect works: Editorial's fallback OVERWRITES
		//   `fellBackFrom`, so this path returns to Grid with the effect removed too.
		//   "via Timing" below is the one that tests the reset
		it("a tab switch away and back re-measures the layout", () => {
			const id = "long:grid:via-editorial";
			expect(at(id, 0).notice, nat(at(id, 0))).toBe(NOTICE.grid);
			// Editorial is measured on its own and falls back on its own.
			expect(at(id, 1).reads.editorial, nat(at(id, 1))).toBe(1);
			expect(at(id, 1).notice, nat(at(id, 1))).toBe(NOTICE.editorial);
			expect(at(id, 1).activeTab, nat(at(id, 1))).toBe("Editorial");
			// Back on Grid: its FitPage mounts and measures once more.
			expect(at(id, 2).reads.grid, nat(at(id, 2))).toBe(1);
			expect(at(id, 2).notice, nat(at(id, 2))).toBe(NOTICE.grid);
			expect(at(id, 2).pages, nat(at(id, 2))).toEqual([PAGE_H, PAGE_H]);
		});

		// protects=the fallback does not outlive the layout it was decided for (AC 8)
		// fails_when=returning to Grid after Timing goes straight to Timing, never mounting
		//   or measuring Grid (the reset effect is missing or does not watch `layout`)
		// no_claim=that the second measurement agrees with the first (same agenda).
		//   Unlike the Editorial path above, nothing overwrites `fellBackFrom` here:
		//   Timing never falls back, so only the reset effect clears it
		it("returning to a layout after Timing measures it again, not remembers the fallback", () => {
			const id = "long:grid:via-timing";
			// Timing is its own layout: no notice, and Grid is not measured while it shows.
			expect(at(id, 1).notice, nat(at(id, 1))).toBeNull();
			expect(at(id, 1).activeTab, nat(at(id, 1))).toBe("Timing");
			expect(at(id, 1).reads.grid ?? 0, nat(at(id, 1))).toBe(0);
			// Back on Grid: mounted and measured afresh, exactly once (then falls back again).
			expect(at(id, 2).reads.grid, nat(at(id, 2))).toBe(1);
			expect(at(id, 2).notice, nat(at(id, 2))).toBe(NOTICE.grid);
			expect(at(id, 2).pages, nat(at(id, 2))).toEqual([PAGE_H, PAGE_H]);
		});

		// protects=a new agenda does not inherit the old one's fallback
		// fails_when=a short agenda that fits Grid stays on Timing because the
		//   previous (long) one fell back
		// no_claim=how the loader hands over new data (a router concern)
		it("new agenda data drops the fallback", () => {
			const id = "long:grid:new-agenda";
			expect(at(id, 0).timing, nat(at(id, 0))).toBe(true);
			const after = at(id, 1);
			expect(after.timing, nat(after)).toBe(false);
			expect(after.notice, nat(after)).toBeNull();
			expect(after.pages, nat(after)).toEqual([PAGE_H]);
		});
	},
);
