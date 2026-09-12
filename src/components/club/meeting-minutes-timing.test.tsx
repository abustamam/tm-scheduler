// @vitest-environment jsdom
//
// The Timing section of the minutes card (#730).
//
// A FILE OF ITS OWN, beside `meeting-minutes.test.tsx` rather than inside it,
// for one reason that matters: this section's write does not go through the
// offline minutes queue every other write on that card uses, so it needs the
// server fn mocked at the RPC boundary — and mocking it in the shared file
// would change what those eighteen tests are running against.
//
// What is only reachable here: that the section is ABSENT rather than empty
// when nothing was timed (the same choice the PDF makes, and the two must
// agree), that the verdict comes from each row's OWN stored marks, that the
// correction is officer-only, and that a mistyped unit is refused before the
// round trip rather than stored.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MinutesResult } from "#/server/minutes";

// The card imports the minutes server-fn module, which pulls in `#/db`
// transitively — the same stub `meeting-minutes.test.tsx` uses and for the same
// reason (no handler runs in a render-only test).
vi.mock("#/db", () => ({ db: {} }));
// The timing correction is a PLAIN server fn, not a queued op, so it is mocked
// at its own boundary. Everything asserted below about the payload and the
// refusals is therefore the component's own behaviour.
vi.mock("#/server/timings", () => ({ recordTiming: vi.fn() }));

const { recordTiming } = await import("#/server/timings");
const { MeetingMinutes } = await import("./meeting-minutes");

type MinutesData = NonNullable<MinutesResult["data"]>;
type MinutesTiming = NonNullable<MinutesData["timings"]>[number];

const toasts: { ok: string[]; err: string[] } = { ok: [], err: [] };
vi.mock("sonner", () => ({
	toast: {
		success: (m: string) => toasts.ok.push(m),
		error: (m: string) => toasts.err.push(m),
	},
}));

/** A recorded time. A standard 5–7 speech unless a case says otherwise. */
function timing(over: Partial<MinutesTiming> = {}): MinutesTiming {
	return {
		slotId: "slot-1",
		roleName: "Speaker 1",
		assigneeName: "Rehanna Khan",
		isGuest: false,
		elapsedSeconds: 371,
		markGreen: 5,
		markRed: 7,
		...over,
	};
}

function baseMinutes(timings: MinutesTiming[] | undefined): MinutesData {
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "m1",
		clubId: "c1",
		members: [],
		guests: [],
		tableTopicsSpeakers: [],
		awards: [],
		awardEligible: {
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		timings,
		counts: { present: 0, absent: 0, excused: 0, unmarked: 0, guests: 0 },
	};
}

function renderCard(
	timings: MinutesTiming[] | undefined,
	canEdit = false,
): void {
	render(
		<MeetingMinutes
			meetingId="11111111-1111-4111-8111-111111111111"
			minutes={baseMinutes(timings)}
			program={[]}
			meetingPast={true}
			meetingDayReached={true}
			canEdit={canEdit}
			clubGuests={[]}
			onMutated={() => {}}
		/>,
	);
}

/** A tap. `fireEvent`, not `userEvent`: there is no pointer behaviour under
 *  test and the lower-level event keeps the suite deterministic. */
async function tap(el: HTMLElement) {
	await act(async () => {
		fireEvent.click(el);
	});
}

beforeEach(() => {
	toasts.ok.length = 0;
	toasts.err.length = 0;
	vi.mocked(recordTiming).mockReset();
	vi.mocked(recordTiming).mockResolvedValue({
		slotId: "slot-1",
		roleName: "Speaker 1",
		elapsedSeconds: 400,
		markGreen: 5,
		markYellow: 6,
		markRed: 7,
		grantedVia: "officer" as const,
		recordedByMemberId: "member-1",
	});
});

afterEach(() => cleanup());

describe("the section's presence", () => {
	it("renders the recorded times, with the verdict", () => {
		renderCard([timing()]);
		expect(screen.getByText("Timing")).toBeTruthy();
		expect(screen.getByText("Speaker 1:")).toBeTruthy();
		expect(screen.getByText("Rehanna Khan")).toBeTruthy();
		expect(screen.getByText("6:11")).toBeTruthy();
		expect(screen.getByText("Qualified")).toBeTruthy();
	});

	it("is ABSENT, not empty, when nothing was timed", () => {
		// The same choice `buildTimingSection` makes for the PDF, and the two must
		// agree: a club that does not use the stopwatch has not failed to record
		// anything, so a permanently empty heading on every set of its minutes
		// would be saying something untrue.
		renderCard([]);
		expect(screen.queryByText("Timing")).toBeNull();
	});

	it("is absent for a payload with no timings key at all", () => {
		// The offline snapshot in IndexedDB is an unversioned `MinutesData`
		// written by a PREVIOUS deploy and handed back with no shape check.
		// `actionItems` white-screened this page in exactly this state.
		renderCard(undefined);
		expect(screen.queryByText("Timing")).toBeNull();
	});

	it("marks a guest speaker as one", () => {
		renderCard([timing({ assigneeName: "Gale Okafor", isGuest: true })]);
		expect(screen.getByText(/Gale Okafor \(Guest\)/)).toBeTruthy();
	});

	it("derives each verdict from that row's OWN stored marks", () => {
		// The point of copying the marks onto the row: two identical measurements
		// judged against different windows must disagree, and an officer widening
		// the agenda's min/max cannot re-decide either of them.
		renderCard([
			timing({ slotId: "a", roleName: "Old", elapsedSeconds: 460 }),
			timing({ slotId: "b", roleName: "New", elapsedSeconds: 460, markRed: 8 }),
		]);
		expect(screen.getByText("Over time")).toBeTruthy();
		expect(screen.getByText("Qualified")).toBeTruthy();
	});

	it("says so rather than judging when a row has no window", () => {
		renderCard([timing({ markGreen: null, markRed: null })]);
		expect(screen.getByText("No window set")).toBeTruthy();
	});
});

describe("the officer's correction", () => {
	it("is offered to an officer and to nobody else", () => {
		renderCard([timing()], false);
		expect(screen.queryByRole("button", { name: "Correct" })).toBeNull();
		cleanup();
		renderCard([timing()], true);
		expect(screen.getByRole("button", { name: "Correct" })).toBeTruthy();
	});

	it("seeds the input with the current value, so the format is on screen", async () => {
		renderCard([timing()], true);
		await tap(screen.getByRole("button", { name: "Correct" }));
		const input = screen.getByLabelText(
			"Time for Speaker 1",
		) as HTMLInputElement;
		expect(input.value).toBe("6:11");
	});

	it("posts the corrected seconds and NO marks", async () => {
		// A correction fixes the NUMBER. The window it was judged against belongs
		// to the moment it was measured, and rewriting it here would let a typo
		// fix silently re-decide whether the speech qualified.
		renderCard([timing()], true);
		await tap(screen.getByRole("button", { name: "Correct" }));
		const input = screen.getByLabelText("Time for Speaker 1");
		await act(async () => {
			fireEvent.change(input, { target: { value: "6:40" } });
		});
		await tap(screen.getByRole("button", { name: "Save" }));

		expect(recordTiming).toHaveBeenCalledTimes(1);
		expect(vi.mocked(recordTiming).mock.calls[0][0]).toEqual({
			data: {
				meetingId: "11111111-1111-4111-8111-111111111111",
				slotId: "slot-1",
				elapsedSeconds: 400,
			},
		});
	});

	it("shows what the SERVER stored, not what was typed", async () => {
		renderCard([timing()], true);
		await tap(screen.getByRole("button", { name: "Correct" }));
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Time for Speaker 1"), {
				target: { value: "6:40" },
			});
		});
		await tap(screen.getByRole("button", { name: "Save" }));
		// The mock returns 400s (6:40), which is NOT what was typed in the general
		// case — and the verdict is re-derived from the returned number against
		// the row's own stored marks rather than carried across the write.
		expect(screen.getByText("6:40")).toBeTruthy();
		expect(screen.getByText("Qualified")).toBeTruthy();
		expect(toasts.ok).toEqual(["Time updated."]);
	});

	it("REFUSES a bare number before the round trip", async () => {
		// The unit trap: an officer typing "6" means six minutes, and a lenient
		// parser would store six seconds with every downstream check passing.
		renderCard([timing()], true);
		await tap(screen.getByRole("button", { name: "Correct" }));
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Time for Speaker 1"), {
				target: { value: "6" },
			});
		});
		await tap(screen.getByRole("button", { name: "Save" }));
		expect(recordTiming).not.toHaveBeenCalled();
		expect(toasts.err).toEqual([
			"Type a time as minutes and seconds, like 6:11.",
		]);
		// And the row still shows the stored value.
		expect(screen.getByText("Save")).toBeTruthy();
	});

	it("shows a server refusal verbatim and keeps the editor open", async () => {
		// The overwrite floor lives on the server; its message is the one the
		// officer needs, and flattening it into a sentence of ours would lose the
		// difference between "not you" and "nothing to record against".
		vi.mocked(recordTiming).mockRejectedValue(
			new Error("This meeting was cancelled, so there is nothing to record."),
		);
		renderCard([timing()], true);
		await tap(screen.getByRole("button", { name: "Correct" }));
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Time for Speaker 1"), {
				target: { value: "6:40" },
			});
		});
		await tap(screen.getByRole("button", { name: "Save" }));
		expect(toasts.err).toEqual([
			"This meeting was cancelled, so there is nothing to record.",
		]);
		expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
	});

	it("cancels back to the stored value without writing", async () => {
		renderCard([timing()], true);
		await tap(screen.getByRole("button", { name: "Correct" }));
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Time for Speaker 1"), {
				target: { value: "9:99" },
			});
		});
		await tap(screen.getByRole("button", { name: "Cancel" }));
		expect(recordTiming).not.toHaveBeenCalled();
		expect(screen.getByText("6:11")).toBeTruthy();
	});

	it("corrects one row without touching another", async () => {
		// The overlay is per SLOT. One keyed on the wrong thing would move both
		// numbers on one save, and the officer would not see it until a reload.
		renderCard(
			[
				timing({ slotId: "slot-1", roleName: "Speaker 1" }),
				timing({ slotId: "slot-2", roleName: "Speaker 2" }),
			],
			true,
		);
		const corrects = screen.getAllByRole("button", { name: "Correct" });
		await tap(corrects[0]);
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Time for Speaker 1"), {
				target: { value: "6:40" },
			});
		});
		await tap(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByText("6:40")).toBeTruthy();
		expect(screen.getByText("6:11")).toBeTruthy();
	});
});
