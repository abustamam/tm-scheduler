// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import type { MinutesOp } from "#/lib/offline-minutes-queue";
import type { MinutesResult } from "#/server/minutes";
import { AwardsSection } from "./awards-section";

vi.mock("#/db", () => ({ db: {} }));

// cmdk (the person picker's list) observes its own size; jsdom has no
// ResizeObserver and scrollIntoView.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const setSpy = vi.fn(async (_a: unknown) => ({ ok: true as const }));
const clearSpy = vi.fn(async (_a: unknown) => ({ ok: true as const }));
vi.mock("#/server/minutes", () => ({
	setMinutesAward: (a: unknown) => setSpy(a),
	clearMinutesAward: (a: unknown) => clearSpy(a),
}));

type MinutesData = NonNullable<MinutesResult["data"]>;

function minutes(over: Partial<MinutesData> = {}): MinutesData {
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "m1",
		clubId: "c1",
		members: [
			{ memberId: "mem-ana", name: "Ana", status: null },
			{ memberId: "mem-ben", name: "Ben", status: null },
		],
		guests: [],
		tableTopicsSpeakers: [],
		awards: [
			{ category: "best_speaker", name: null, isGuest: false },
			{ category: "best_evaluator", name: "Ben", isGuest: false },
			{ category: "best_table_topics", name: null, isGuest: false },
		],
		awardEligible: {
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		counts: { present: 0, absent: 0, excused: 0, unmarked: 0, guests: 0 },
		...over,
	} as unknown as MinutesData;
}

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

function renderSection(
	props: { canEdit: boolean; onChangeInBallots?: () => void } = {
		canEdit: true,
	},
) {
	return render(
		<AwardsSection
			meetingId="m1"
			minutes={minutes()}
			offline={offlineStub()}
			clubGuests={[{ id: "g-1", name: "Gia" }]}
			{...props}
		/>,
	);
}

function op(): MinutesOp {
	if (!captured) throw new Error("mutate was never called");
	return captured.makeOp();
}

describe("AwardsSection (#1583)", () => {
	beforeEach(() => {
		captured = null;
		setSpy.mockClear();
		clearSpy.mockClear();
	});
	afterEach(() => cleanup());

	// protects=Minutes cannot edit awards; fails_when=a Set/Change/Clear control
	// renders when canEdit is false; no_claim=the Ballots tab offers it
	it("renders no Set, Change or Clear control read-only, but still lists the winners", () => {
		renderSection({ canEdit: false });
		expect(screen.getByText("Best Evaluator")).toBeTruthy();
		expect(screen.getByText(/Ben/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Set" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
	});

	// protects=the Minutes link appears only when a handler is given and the
	// list is read-only; fails_when=it renders editable or without a handler, or
	// does not call the handler; no_claim=that the route switches the tab
	it("shows Change in Ballots only read-only and with a handler", () => {
		const go = vi.fn();
		const { unmount } = renderSection({
			canEdit: false,
			onChangeInBallots: go,
		});
		fireEvent.click(screen.getByRole("button", { name: "Change in Ballots" }));
		expect(go).toHaveBeenCalledTimes(1);
		unmount();
		renderSection({ canEdit: false });
		expect(screen.queryByText("Change in Ballots")).toBeNull();
		cleanup();
		renderSection({ canEdit: true, onChangeInBallots: go });
		expect(screen.queryByText("Change in Ballots")).toBeNull();
	});

	// protects=an officer can set, change and clear; fails_when=a control is
	// missing for its state (Set when unset, Change+Clear when set)
	it("offers Set when unset and Change plus Clear when set", () => {
		renderSection();
		expect(screen.getAllByRole("button", { name: "Set" })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: "Change" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(1);
	});

	// protects=Clear queues the op the minutes card queued before the move;
	// fails_when=the op type or category changes; no_claim=server behaviour
	it("clear calls mutate with the clearAward op and the online call", async () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(op()).toMatchObject({
			type: "clearAward",
			category: "best_evaluator",
			opId: "op-fixed",
		});
		await captured?.onlineFn();
		expect(clearSpy).toHaveBeenCalledWith({
			data: { meetingId: "m1", category: "best_evaluator" },
		});
	});

	// protects=a roster member pick keeps its op shape on both channels;
	// fails_when=memberId or the resolved name is dropped
	it("set with a member carries memberId and the member's name", async () => {
		renderSection();
		fireEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
		fireEvent.click(await screen.findByText("Ana"));
		expect(op()).toMatchObject({
			type: "setAward",
			category: "best_speaker",
			name: "Ana",
			isGuest: false,
			memberId: "mem-ana",
		});
		await captured?.onlineFn();
		expect(setSpy).toHaveBeenCalledWith({
			data: { meetingId: "m1", category: "best_speaker", memberId: "mem-ana" },
		});
	});

	// protects=an existing guest pick keeps its op shape; fails_when=guestId is
	// dropped or the op is marked a member
	it("set with an existing guest carries guestId and isGuest", async () => {
		renderSection();
		fireEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
		fireEvent.click(await screen.findByText("Gia"));
		expect(op()).toMatchObject({
			type: "setAward",
			name: "Gia",
			isGuest: true,
			guestId: "g-1",
		});
	});

	// protects=a new guest mints a client id so a drain replay is idempotent;
	// fails_when=newGuestId is missing or the name is lost
	it("set with a new guest carries newGuest and a minted newGuestId", async () => {
		renderSection();
		fireEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
		fireEvent.change(await screen.findByLabelText("New guest name"), {
			target: { value: "Zoe" },
		});
		fireEvent.submit(
			screen
				.getByLabelText("New guest name")
				.closest("form") as HTMLFormElement,
		);
		const o = op() as Extract<MinutesOp, { type: "setAward" }>;
		expect(o).toMatchObject({
			type: "setAward",
			name: "Zoe",
			isGuest: true,
			newGuest: { name: "Zoe" },
		});
		expect(typeof o.newGuestId).toBe("string");
	});
});
