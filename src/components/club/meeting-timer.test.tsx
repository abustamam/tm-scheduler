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
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaRow, AgendaSlot } from "#/lib/agenda-runsheet";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// `meeting-timer.tsx` imports the writer, which reaches `#/db` and throws
// `DATABASE_URL is not set` at module load. Mocked at the SERVER-FN boundary —
// what is faked is the RPC, so everything this file asserts about the payload,
// the refusals and the receipt is the component's own behaviour.
vi.mock("#/server/timings", () => ({ recordTiming: vi.fn() }));

const { recordTiming } = await import("#/server/timings");
const { buildTimerSegments, MeetingTimer } = await import("./meeting-timer");

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

/** The two `role_definitions` columns `isTimeableRole` reads, per slot. */
function slot(
	over: Partial<Pick<AgendaSlot, "id" | "isSpeakerRole" | "category">> = {},
): Pick<AgendaSlot, "id" | "isSpeakerRole" | "category"> {
	return { id: "slot-1", isSpeakerRole: true, category: "speaker", ...over };
}

/** What the server hands back on a successful record. */
function saved(over: Record<string, unknown> = {}) {
	return {
		slotId: "slot-1",
		roleName: "Speaker 1",
		elapsedSeconds: 371,
		markGreen: 5,
		markYellow: 6,
		markRed: 7,
		grantedVia: "self" as const,
		recordedByMemberId: "member-1",
		...over,
	};
}

const RECORDING = {
	meetingId: "11111111-1111-4111-8111-111111111111",
	actorMemberId: "member-1",
	canRecord: true,
};

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
async function mount(
	rows: AgendaRow[],
	limits = LIMITS,
	extra: {
		slots?: Pick<AgendaSlot, "id" | "isSpeakerRole" | "category">[];
		recording?: typeof RECORDING;
		/** Render under `<StrictMode>`, which double-invokes renders, state
		 *  updaters and effects. See the StrictMode case at the bottom. */
		strict?: boolean;
	} = {},
) {
	const wrap = (ui: React.ReactNode) =>
		extra.strict ? <StrictMode>{ui}</StrictMode> : ui;
	await renderUnderMemoryRouter(
		wrap(
			<MeetingTimer
				when="Tuesday, September 15, 2026"
				backHref="/club/harbor-city/meeting/2026-09-15/me"
				rows={rows}
				tableTopicsLimits={limits}
				slots={extra.slots}
				recording={extra.recording}
			/>,
		),
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

beforeEach(() => {
	vi.mocked(recordTiming).mockReset();
	vi.mocked(recordTiming).mockResolvedValue(saved());
});

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

	it("marks a slot-backed timeable row recordable, and nothing else", () => {
		// The two questions are separate on purpose: every marked row gets a
		// CLOCK, only a slot-backed timeable one gets a RECORD.
		const segments = buildTimerSegments(
			[
				row({ slotId: "speaker", roleKey: "speaker" }),
				row({ slotId: "evaluator", roleKey: "evaluator" }),
				row({ slotId: "ttm", roleKey: "table_topics_master" }),
				row({ slotId: null, roleKey: null }),
				row({ slotId: "unknown-to-the-caller" }),
			],
			[
				slot({ id: "speaker", isSpeakerRole: true, category: "speaker" }),
				slot({ id: "evaluator", isSpeakerRole: false, category: "evaluator" }),
				// The Table Topics row binds the MASTER's slot, which is leadership —
				// so a stored number would be one time for a segment with four to
				// eight speakers, attributed to whoever asked the questions.
				slot({ id: "ttm", isSpeakerRole: false, category: "leadership" }),
			],
		);
		expect(segments.map((x) => x.recordable)).toEqual([
			true,
			true,
			false,
			false,
			false,
		]);
		// And WHY not, which is a different fact per row. The Table Topics row is
		// refused for its ROLE; the slot-less row for being about no one turn;
		// the row whose slot the caller did not describe gets no explanation at
		// all, because this surface has nothing to judge it by.
		expect(segments.map((x) => x.unrecordableReason)).toEqual([
			null,
			null,
			"not-timeable",
			"no-single-slot",
			null,
		]);
	});

	it("blames the ROW, not the role, on a Speaker row bound to no single slot", () => {
		// #732 leaves `slotId` null on a non-repeating role beat bound to two or
		// more slots, and that row is often a Speaker. Reusing the role message
		// there tells the Timer a speech "isn't a speech".
		const [seg] = buildTimerSegments(
			[row({ slotId: null, roleKey: "speaker", roleLabel: "Speakers" })],
			[slot()],
		);
		expect(seg.unrecordableReason).toBe("no-single-slot");
	});

	it("records nothing at all when the caller passes no slots", () => {
		// #729's shape. With no slot columns there is nothing to ask
		// `isTimeableRole`, and guessing would be the wrong default.
		const segments = buildTimerSegments([row()]);
		expect(segments[0].recordable).toBe(false);
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

describe("recording on stop (#730)", () => {
	it("posts the measurement, the marks and the asserted identity", async () => {
		await mount([row()], LIMITS, { slots: [slot()], recording: RECORDING });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(371_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});

		expect(recordTiming).toHaveBeenCalledTimes(1);
		expect(vi.mocked(recordTiming).mock.calls[0][0]).toEqual({
			data: {
				meetingId: RECORDING.meetingId,
				slotId: "slot-1",
				elapsedSeconds: 371,
				// The marks the clock was JUDGED against travel with it, so the row
				// records the window in force at the time and a later agenda edit
				// cannot silently re-decide whether the speech qualified.
				marks: { green: 5, yellow: 6, red: 7 },
				actorMemberId: RECORDING.actorMemberId,
			},
		});
	});

	it("shows the recorded time and the verdict, from what the SERVER stored", async () => {
		// Not from what this render happens to hold: the mock returns a DIFFERENT
		// number from the one the clock measured, and the receipt must show the
		// server's — if the two ever differ, the stored row is the record.
		vi.mocked(recordTiming).mockResolvedValue(
			saved({ elapsedSeconds: 500, markGreen: 5, markRed: 7 }),
		);
		await mount([row()], LIMITS, { slots: [slot()], recording: RECORDING });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(371_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		// 8:20 against a 4:30–7:30 window, and the clock said 6:11.
		expect(screen.getByText("Recorded 8:20 · Over time")).toBeTruthy();
	});

	it("records the STOP's reading, not a later render's", async () => {
		// The clock is stopped; time keeps passing. A record that re-measured on
		// the next tick would store whatever the render loop happened to see.
		await mount([row()], LIMITS, { slots: [slot()], recording: RECORDING });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await advance(600_000);
		await act(async () => {});
		const payload = vi.mocked(recordTiming).mock.calls[0]?.[0] as {
			data: { elapsedSeconds: number };
		};
		expect(payload.data.elapsedSeconds).toBe(9);
	});

	it("records on STOP and on nothing else", async () => {
		// A pause is not a finished measurement.
		await mount([row()], LIMITS, { slots: [slot()], recording: RECORDING });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Pause" }));
		await act(async () => {});
		expect(recordTiming).not.toHaveBeenCalled();
		await tap(screen.getByRole("button", { name: "Resume" }));
		await advance(3_000);
		await act(async () => {});
		expect(recordTiming).not.toHaveBeenCalled();
	});

	it("writes nothing when the caller passed no recording context", async () => {
		// #729's ephemeral stopwatch, which is what an unidentified visitor gets.
		await mount([row()], LIMITS, { slots: [slot()] });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(recordTiming).not.toHaveBeenCalled();
		expect(screen.queryByText(/Recorded/)).toBeNull();
	});

	it("writes nothing, and explains nothing, for a viewer who may not record", async () => {
		// Silence is right here: a member who holds none of the three
		// capabilities is not being denied anything they were offered.
		await mount([row()], LIMITS, {
			slots: [slot()],
			recording: { ...RECORDING, canRecord: false },
		});
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(recordTiming).not.toHaveBeenCalled();
		expect(screen.queryByText(/isn't a speech or an evaluation/)).toBeNull();
	});

	it("offers no recording for the Table Topics row, and says why", async () => {
		// The trap #730 exists to close: that row IS slot-backed (the Table
		// Topics Master's), so a naive write would type-check, insert cleanly and
		// store one wrong number. The Timer still gets a working clock.
		await mount(
			[
				row({
					slotId: "ttm",
					roleKey: "table_topics_master",
					roleLabel: "Table Topics",
				}),
			],
			LIMITS,
			{
				slots: [
					slot({ id: "ttm", isSpeakerRole: false, category: "leadership" }),
				],
				recording: RECORDING,
			},
		);
		expect(screen.getByText(/isn't a speech or an evaluation/)).toBeTruthy();
		// The ROLE's reason, and it is the server's own string rather than a
		// re-wording — the refusal a hand-made request gets and the explanation
		// on screen are one sentence.
		expect(screen.queryByText(/isn't one person's turn/)).toBeNull();
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(60_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(recordTiming).not.toHaveBeenCalled();
		expect(screen.getByText("1:00")).toBeTruthy();
	});

	it("offers no recording for a row with no slot, and gives the ROW's reason", async () => {
		await mount(
			[row({ slotId: null, roleKey: "speaker", roleLabel: "Speakers" })],
			LIMITS,
			{
				slots: [slot()],
				recording: RECORDING,
			},
		);
		// The row's reason, NOT the role's: this one is a Speaker row, and
		// "isn't a speech or an evaluation" would be untrue as well as unhelpful.
		expect(screen.getByText(/isn't one person's turn/)).toBeTruthy();
		expect(screen.queryByText(/isn't a speech or an evaluation/)).toBeNull();
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(60_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(recordTiming).not.toHaveBeenCalled();
	});

	it("shows a refusal VERBATIM and keeps the clock's reading", async () => {
		// The two server refusals mean different things — "no one speaker here"
		// and "not you" — so the surface must not flatten them into one sentence
		// of its own. And the measurement is not lost because the write was
		// refused: a Timer who thinks it is stops trusting the surface mid-meeting.
		vi.mocked(recordTiming).mockRejectedValue(
			new Error("Someone else already recorded a time for this segment."),
		);
		await mount([row()], LIMITS, { slots: [slot()], recording: RECORDING });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(9_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(
			screen.getByText(
				"Someone else already recorded a time for this segment.",
			),
		).toBeTruthy();
		expect(screen.getByText("0:09")).toBeTruthy();
	});

	it("clears the receipt on reset, so it never sits under a 0:00 clock", async () => {
		await mount([row()], LIMITS, { slots: [slot()], recording: RECORDING });
		await tap(screen.getByRole("button", { name: "Start" }));
		await advance(371_000);
		await tap(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(screen.getByText(/^Recorded /)).toBeTruthy();
		await tap(screen.getByRole("button", { name: "Reset" }));
		await act(async () => {});
		expect(screen.queryByText(/^Recorded /)).toBeNull();
		expect(screen.getByText("0:00")).toBeTruthy();
	});
});

describe("StrictMode", () => {
	it("sends ONE POST per Stop, even when React double-invokes", async () => {
		// THE BUG THIS EXISTS FOR. The record used to be fired from inside
		// `setStates((prev) => …)`. A state updater must be pure: StrictMode
		// double-invokes them and a concurrent render can replay them, so one Stop
		// sent TWO `recordTiming` POSTs — a duplicated measurement of a real
		// speech, stored under the same slot and therefore invisible afterwards.
		//
		// Every other case in this file renders OUTSIDE StrictMode, so a
		// `toHaveBeenCalledTimes(1)` there passes on the broken code. This one is
		// the only assertion that can fail on it, which is why it renders the
		// whole surface a second way rather than asserting the fix's shape.
		await mount([row()], LIMITS, {
			slots: [slot()],
			recording: RECORDING,
			strict: true,
		});
		await tap(screen.getAllByRole("button", { name: "Start" })[0]);
		await advance(371_000);
		await tap(screen.getAllByRole("button", { name: "Stop" })[0]);
		await act(async () => {});
		expect(recordTiming).toHaveBeenCalledTimes(1);
	});

	it("keeps one clock per segment under a double-invoked render", async () => {
		// The other half: a reducer run from a doubled updater would advance the
		// clock twice per tap. The ref this now writes from is only touched by the
		// event handler, which React never doubles.
		await mount([row()], LIMITS, {
			slots: [slot()],
			recording: RECORDING,
			strict: true,
		});
		await tap(screen.getAllByRole("button", { name: "Start" })[0]);
		await advance(9_000);
		expect(screen.getAllByText("0:09").length).toBeGreaterThan(0);
	});
});
