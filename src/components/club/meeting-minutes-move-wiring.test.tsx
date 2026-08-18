// @vitest-environment jsdom
//
// The ABSOLUTE `toIndex` a Table Topics move carries is COMPUTED at this call
// site, and a computed prop is untested by construction — CLAUDE.md's "a
// component tested through its props cannot see a WRONG prop". `TableTopicsCapture`
// is well covered and hands `onMove(id, direction)` up unchanged; the expression
// that turns that into a position lives in `meeting-minutes.tsx` and is reached by
// nothing else. Drop `toIndex` there and every other gate stays green while every
// replayed move steps the row a second position again (G2) — the whole fix inert,
// with the server, the drain mapping and the client mirror all still correct.
//
// So this file renders the real card, clicks the real button, and reads BOTH
// channels the tap opens: the op that goes in the durable queue (what the drain
// replays) and the payload of the online server-fn call. A separate file rather
// than an addition to `meeting-minutes.test.tsx` because it needs
// `#/server/minutes` mocked, and that file's other tests deliberately import it
// for real.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import type { MinutesOp } from "#/lib/offline-minutes-queue";
import type { MinutesResult } from "#/server/minutes";
import { MeetingMinutes } from "./meeting-minutes";

vi.mock("#/db", () => ({ db: {} }));

/** Every server fn the card can reach, so invoking the captured ONLINE thunk
 *  records a payload instead of hitting a real handler. */
const moveTableTopicsSpy = vi.fn(async () => ({ ok: true as const }));
vi.mock("#/server/minutes", () => ({
	addTableTopics: vi.fn(async () => ({})),
	removeTableTopics: vi.fn(async () => ({})),
	moveTableTopics: (...args: unknown[]) =>
		(moveTableTopicsSpy as (...a: unknown[]) => Promise<unknown>)(...args),
	setMinutesAward: vi.fn(async () => ({})),
	clearMinutesAward: vi.fn(async () => ({})),
	setAttendance: vi.fn(async () => ({})),
	addMinutesGuest: vi.fn(async () => ({})),
	removeMinutesGuest: vi.fn(async () => ({})),
}));

type MinutesData = NonNullable<MinutesResult["data"]>;

/** Three speakers in a known order, so a move has a neighbour on both sides and
 *  the middle row's index is neither 0 nor `length - 1`. */
function threeSpeakers(): MinutesData {
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "m1",
		clubId: "c1",
		members: [],
		guests: [],
		tableTopicsSpeakers: [
			{
				id: "tt-a",
				memberId: null,
				guestId: null,
				name: "Alice",
				isGuest: false,
				topic: null,
				sortOrder: 0,
			},
			{
				id: "tt-b",
				memberId: null,
				guestId: null,
				name: "Bob",
				isGuest: false,
				topic: null,
				sortOrder: 1,
			},
			{
				id: "tt-c",
				memberId: null,
				guestId: null,
				name: "Carol",
				isGuest: false,
				topic: null,
				sortOrder: 2,
			},
		],
		awards: [],
		awardEligible: {
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		counts: { present: 0, absent: 0, excused: 0, unmarked: 0, guests: 0 },
	};
}

/** Captures both arguments `mutate` is handed, which is the only way to see the
 *  op the queue would get AND the payload the network would get from one tap. */
let captured: {
	onlineFn: () => Promise<unknown>;
	makeOp: () => MinutesOp;
} | null = null;

const offlineStub = () =>
	({
		mutate: async (
			onlineFn: () => Promise<unknown>,
			makeOp: () => MinutesOp,
		) => {
			captured = { onlineFn, makeOp };
		},
		opMeta: () => ({ opId: "op-fixed", queuedAt: 1 }),
		busy: false,
		queue: [] as MinutesOp[],
		snapshot: null,
		draining: false,
		syncError: null,
		justSynced: false,
		retryDrain: async () => {},
	}) as unknown as ReturnType<typeof useOfflineMinutes>;

function renderCard() {
	return render(
		<MeetingMinutes
			meetingId="m1"
			minutes={threeSpeakers()}
			program={[]}
			meetingPast={true}
			meetingDayReached={true}
			canEdit={true}
			clubGuests={[]}
			offline={offlineStub()}
		/>,
	);
}

/** The op the tap would put in the durable queue. */
function queuedOp() {
	if (!captured) throw new Error("mutate was never called");
	return captured.makeOp();
}

describe("Table Topics move wiring (G2)", () => {
	beforeEach(() => {
		captured = null;
		moveTableTopicsSpy.mockClear();
	});
	afterEach(() => cleanup());

	it("mints an op carrying the ABSOLUTE destination for a move DOWN", async () => {
		renderCard();
		// Row 0's "Move down". Its "Move up" is disabled, so the enabled controls and
		// the array indices line up the way the component's own edge logic expects.
		screen.getAllByLabelText("Move down")[0].click();

		expect(queuedOp()).toMatchObject({
			type: "moveTableTopics",
			id: "tt-a",
			direction: "down",
			// 0 → 1. Without this the drain replays a relative step and moves the row
			// a second position, silently reordering the saved minutes.
			toIndex: 1,
		});
	});

	it("mints an op carrying the ABSOLUTE destination for a move UP", async () => {
		renderCard();
		// The LAST row's "Move up" — index 2 → 1. A `toIndex` hard-coded to the
		// direction, or computed off the wrong row, cannot satisfy this and the
		// down-case together.
		const ups = screen.getAllByLabelText("Move up");
		ups[ups.length - 1].click();

		expect(queuedOp()).toMatchObject({
			type: "moveTableTopics",
			id: "tt-c",
			direction: "up",
			toIndex: 1,
		});
	});

	it("sends the same absolute destination on the ONLINE channel", async () => {
		renderCard();
		screen.getAllByLabelText("Move down")[1].click();
		if (!captured) throw new Error("mutate was never called");

		await captured.onlineFn();

		// Both channels must agree, or the first apply and its replay disagree about
		// what the officer asked for: `mutate` runs the online thunk when the queue is
		// empty and the queued op when it is not, so a `toIndex` present on only one
		// of them is a bug that shows up exactly once, on reconnect.
		expect(moveTableTopicsSpy).toHaveBeenCalledWith({
			data: { meetingId: "m1", id: "tt-b", direction: "down", toIndex: 2 },
		});
	});

	// NOT tested here: the out-of-range guard that keeps `-1` off the wire. Both
	// edge buttons are `disabled` for the only list shape that could produce it (a
	// single row disables up on `i === 0` and down on `i === speakers.length - 1`),
	// so reaching it means defeating the component's own guard and asserting on a
	// state the app cannot enter. The SEMANTICS it protects are covered where they
	// are reachable: `minutes-idempotent.integration.test.ts` no-ops an out-of-range
	// `toIndex` server-side and `derive-minutes.test.ts` does the same client-side.
});
