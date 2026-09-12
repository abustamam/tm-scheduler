// @vitest-environment jsdom
//
// Render tests for the Timer's stopwatch surface (#729).
//
// The reducer and the band rule are unit-tested next door
// (`src/lib/timer-state.test.ts`, `src/lib/timer-signal.test.ts`) against exact
// instants. What is only reachable HERE is the wiring between them and the
// DOM: which rows get a clock, that the printed marks are the run sheet's own
// strings, that each row's clock is independent of every other row's, and that
// the wake lock is taken and — the half that costs a Timer their battery for
// the evening — RELEASED.
//
// Time is driven with `vi.useFakeTimers()` and `vi.setSystemTime`, not with
// sleeps. `elapsedMs` reads `Date.now()` on every render, so moving the system
// clock and advancing the interval is a real measurement of a real duration,
// with none of the flake a wall-clock wait brings on a loaded CI box.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaRow } from "#/lib/agenda-runsheet";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { buildTimerSegments, MeetingTimer } from "./meeting-timer";

const T0 = new Date("2026-09-15T18:00:00.000Z").getTime();

/** A run-sheet row. Only the fields this surface reads are set. */
function row(over: Partial<AgendaRow> = {}): AgendaRow {
	return {
		who: "Speaker 1 · Rehanna Khan",
		roleLabel: "Speaker 1",
		holder: "Rehanna Khan",
		roleKey: "speaker",
		slotId: "slot-1",
		detail: "",
		minutes: 7,
		marks: { green: 5, yellow: 6, red: 7 },
		...over,
	};
}

const LIMITS = { minSeconds: 60, maxSeconds: 150 };

/**
 * Mount, then wind the clock.
 *
 * The ORDER is the whole trick, and it took a 60-second timeout to find:
 * `renderUnderMemoryRouter` ends in a `waitFor` on the router reaching idle,
 * and `waitFor` schedules its own polling timers — so under
 * `vi.useFakeTimers()` installed FIRST it waits forever on a clock nobody is
 * advancing. Installing them after the render leaves the harness on real
 * timers, where it belongs, and still puts every clock the component reads
 * onto the fake one: nothing is running at mount, so the only `Date.now()` that
 * has happened is the initial `now` of an idle clock, which is worth 0:00 at
 * any instant.
 */
async function mount(rows: AgendaRow[], limits = LIMITS) {
	await renderUnderMemoryRouter(
		<MeetingTimer
			when="Tuesday, September 15, 2026"
			backHref="/club/harbor-city/meeting/2026-09-15/me"
			rows={rows}
			tableTopicsLimits={limits}
		/>,
	);
	vi.useFakeTimers({ shouldAdvanceTime: false });
	clock = T0;
	vi.setSystemTime(new Date(T0));
}

/**
 * A tap. `fireEvent` rather than `userEvent`, deliberately: `userEvent` awaits
 * its own zero-delay timers, and under `vi.useFakeTimers()` that turns every
 * click into a negotiation between two clocks — the first cut of this file took
 * 150 seconds and failed fifteen ways. There is no pointer behaviour under test
 * here (no hover, no focus order, no typing), so the lower-level event is the
 * right tool and the deterministic one.
 */
async function tap(el: HTMLElement) {
	await act(async () => {
		fireEvent.click(el);
	});
}

/** The test's own wall clock, so `advance` composes across a whole speech. */
let clock = T0;

/**
 * Move the wall clock forward and let ONE repaint tick fire.
 *
 * Deliberately one tick and not `ms / 200` of them. The measurement comes from
 * the wall clock on every render, so a single render after the jump shows
 * exactly what the Timer would see — and running the full span instead costs
 * 1,500 renders for a seven-minute speech (150 seconds of suite time, measured)
 * while proving nothing extra. It is also the truer model of the conditions
 * this surface runs in: a backgrounded phone drops most of its ticks, and the
 * clock still has to be right when the next one lands.
 *
 * The 200ms rewind keeps the arithmetic exact, so an assertion can name the
 * instant it means rather than absorbing a per-call drift.
 */
async function advance(ms: number) {
	clock += ms;
	await act(async () => {
		vi.setSystemTime(new Date(clock - 200));
		await vi.advanceTimersByTimeAsync(200);
	});
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("buildTimerSegments — which rows get a clock", () => {
	it("keeps only the rows with marks, in run-sheet order", () => {
		const segments = buildTimerSegments([
			row({ roleLabel: "Speaker 1", slotId: "a" }),
			row({ roleLabel: "Business", slotId: null, marks: null, roleKey: null }),
			row({ roleLabel: "Speaker 2", slotId: "b" }),
		]);
		expect(segments.map((s) => s.roleLabel)).toEqual([
			"Speaker 1",
			"Speaker 2",
		]);
	});

	it("clocks a marked row whose slotId is NULL", () => {
		// The rule #729 states and #730 depends on: a null `slotId` costs the
		// ability to RECORD, never the ability to measure. An officer who put
		// marks on an event beat still wants to time it.
		const segments = buildTimerSegments([
			row({ roleLabel: "Club business", slotId: null, roleKey: null }),
		]);
		expect(segments).toHaveLength(1);
		expect(segments[0].slotId).toBeNull();
		// Keyed by run-sheet position, because that is all a slot-less row has.
		expect(segments[0].key).toBe("row-0");
	});

	it("keys a slot-backed row by its slot id, not its position", () => {
		// A position key would move the moment anyone adds a row above, taking a
		// running clock's state with it.
		const segments = buildTimerSegments([row({ slotId: "slot-xyz" })]);
		expect(segments[0].key).toBe("slot-xyz");
	});

	it("marks the Table Topics row as the other DQ rule", () => {
		const segments = buildTimerSegments([
			row({ roleKey: "table_topics_master", roleLabel: "Table Topics" }),
			row({ roleKey: "speaker" }),
			row({ roleKey: "evaluator" }),
			row({ roleKey: null, slotId: null }),
		]);
		expect(segments.map((s) => s.kind)).toEqual([
			"tableTopics",
			"speech",
			"speech",
			"speech",
		]);
	});

	it("falls back to `who` when a row carries no split label", () => {
		// The template path sets `roleLabel`; older shapes only set `who`, and a
		// blank heading on the Timer's card is worse than the ambiguous string.
		const segments = buildTimerSegments([
			row({ roleLabel: undefined, holder: undefined, who: "Sergeant-at-Arms" }),
		]);
		expect(segments[0].roleLabel).toBe("Sergeant-at-Arms");
		expect(segments[0].holder).toBeNull();
	});
});

describe("rendering", () => {
	it("renders one clock per timed segment, with role and holder", async () => {
		await mount([
			row({ roleLabel: "Speaker 1", holder: "Rehanna Khan", slotId: "a" }),
			row({ roleLabel: "Speaker 2", holder: "Dan Oyelaran", slotId: "b" }),
		]);
		expect(screen.getByRole("heading", { name: "Speaker 1" })).toBeTruthy();
		expect(screen.getByText("Rehanna Khan")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Speaker 2" })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(2);
	});

	it("prints the marks as the SAME clock strings the agenda prints", async () => {
		// `formatTimingClock` is the one formatter the printed agenda, the Timer's
		// role sheet and this surface all go through — 6.5 minutes is "6:30"
		// everywhere or the phone and the paper disagree.
		await mount([row({ marks: { green: 5, yellow: 6.5, red: 7 } })]);
		expect(screen.getByText(/Green 5:00/)).toBeTruthy();
		expect(screen.getByText(/Yellow 6:30/)).toBeTruthy();
		expect(screen.getByText(/Red 7:00/)).toBeTruthy();
		// And the grace window the Timer is actually judging against.
		expect(screen.getByText(/Qualifies 4:30–7:30/)).toBeTruthy();
	});

	it("shows an explicit empty state, not a blank page", async () => {
		await mount([row({ marks: null })]);
		expect(
			screen.getByText(/Nothing on this agenda has timing marks/),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
	});

	it("offers a way back to the personal meeting page", async () => {
		await mount([row()]);
		expect(
			screen
				.getByRole("link", { name: "Back to your meeting page" })
				.getAttribute("href"),
		).toBe("/club/harbor-city/meeting/2026-09-15/me");
	});
});

describe("the clock", () => {
	it("counts up from 0:00 and changes band at the marks", async () => {
		await mount([row({ marks: { green: 5, yellow: 6, red: 7 } })]);
		expect(screen.getByText("0:00")).toBeTruthy();
		expect(screen.getByText("Before green")).toBeTruthy();

		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(5 * 60_000);
		expect(screen.getByText("5:00")).toBeTruthy();
		expect(screen.getByText("Green")).toBeTruthy();

		await advance(60_000);
		expect(screen.getByText("6:00")).toBeTruthy();
		expect(screen.getByText("Yellow")).toBeTruthy();

		await advance(60_000);
		expect(screen.getByText("7:00")).toBeTruthy();
		expect(screen.getByText("Red")).toBeTruthy();

		// Past the 30-second grace: over, which is NOT the red card.
		await advance(31_000);
		expect(screen.getByText("Over time")).toBeTruthy();
	});

	it("uses the club's Table Topics cap, not the speech grace", async () => {
		// 2:30 cap ⇒ disqualified at 2:31, thirty seconds before the speech rule
		// would say so. Two clocks in one club must not answer to one rule.
		await mount([
			row({
				roleKey: "table_topics_master",
				roleLabel: "Table Topics",
				marks: { green: 1, yellow: 1.75, red: 2.5 },
			}),
		]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(150_000);
		expect(screen.getByText("Red")).toBeTruthy();
		await advance(1000);
		expect(screen.getByText("Over time")).toBeTruthy();
	});

	it("pauses, resumes, and excludes the paused span from the measurement", async () => {
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(10_000);
		await tap(screen.getByRole("button", { name: "Pause" }));
		await advance(60_000);
		// Frozen through a minute of pause.
		expect(screen.getByText("0:10")).toBeTruthy();
		await tap(screen.getByRole("button", { name: "Resume" }));
		await advance(5_000);
		expect(screen.getByText("0:15")).toBeTruthy();
	});

	it("stops, holding the final reading", async () => {
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await advance(120_000);
		expect(screen.getByText("0:09")).toBeTruthy();
		// A stopped clock offers no Start — a finished measurement needs a reset.
		expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
		expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
	});

	it("resets back to idle", async () => {
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Reset" }));
		expect(screen.getByText("0:00")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
	});

	it("runs each segment's clock independently", async () => {
		// One shared `now` drives every row, so a bug that shared STATE too would
		// start both clocks on one tap — and the Timer would record the same
		// number twice.
		await mount([
			row({ roleLabel: "Speaker 1", slotId: "a" }),
			row({ roleLabel: "Speaker 2", slotId: "b" }),
		]);
		const starts = screen.getAllByRole("button", { name: "Start" });
		await tap(starts[0]);
		await advance(12_000);
		expect(screen.getByText("0:12")).toBeTruthy();
		expect(screen.getByText("0:00")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(1);
	});
});

describe("the wake lock", () => {
	function stubWakeLock() {
		const release = vi.fn(async () => {});
		const request = vi.fn(async () => ({ release }));
		vi.stubGlobal("navigator", {
			...navigator,
			wakeLock: { request },
		});
		return { request, release };
	}

	it("is requested when a clock starts and released when it pauses", async () => {
		const { request, release } = stubWakeLock();
		await mount([row()]);
		expect(request).not.toHaveBeenCalled();

		await tap(screen.getByRole("button", { name: "Start" }));
		await act(async () => {});
		expect(request).toHaveBeenCalledWith("screen");

		await tap(screen.getByRole("button", { name: "Pause" }));
		await act(async () => {});
		expect(release).toHaveBeenCalled();
	});

	it("is released on stop", async () => {
		const { release } = stubWakeLock();
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await act(async () => {});
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(release).toHaveBeenCalled();
	});

	it("is released on unmount", async () => {
		// The one that costs a battery: this page stays open all evening, and a
		// lock held past the last tap is never dropped by anything else.
		const { release } = stubWakeLock();
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await act(async () => {});
		expect(release).not.toHaveBeenCalled();
		cleanup();
		await act(async () => {});
		expect(release).toHaveBeenCalled();
	});

	it("works with no wakeLock API at all", async () => {
		// Safari's support is partial. A Timer whose browser has none must still
		// get a working stopwatch rather than a thrown render.
		vi.stubGlobal("navigator", { ...navigator, wakeLock: undefined });
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(3_000);
		expect(screen.getByText("0:03")).toBeTruthy();
	});

	it("survives a wakeLock request that rejects", async () => {
		// A denied lock (a hidden tab, a policy) must be silent and non-fatal.
		vi.stubGlobal("navigator", {
			...navigator,
			wakeLock: { request: vi.fn(async () => Promise.reject(new Error("no"))) },
		});
		await mount([row()]);
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(3_000);
		expect(screen.getByText("0:03")).toBeTruthy();
	});
});
