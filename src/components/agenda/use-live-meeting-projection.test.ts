// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleSlotOp } from "#/lib/offline-minutes-queue";
import type { DrainedRoleOp } from "#/lib/project-slots";
import { useLiveMeeting } from "./use-live-meeting";

const h = vi.hoisted(() => ({
	listeners: new Set<() => void>(),
	drainedListeners: new Set<(d: unknown[], at: number) => void>(),
	queue: [] as unknown[],
}));
vi.mock("#/lib/agenda-live", () => ({
	subscribeAgendaChanged: (cb: () => void) => {
		h.listeners.add(cb);
		return () => h.listeners.delete(cb);
	},
}));
vi.mock("#/lib/drained-roles", () => ({
	subscribeRoleOpsDrained: (cb: (d: unknown[], at: number) => void) => {
		h.drainedListeners.add(cb);
		return () => h.drainedListeners.delete(cb);
	},
}));
vi.mock("#/lib/offline-minutes-queue", () => ({
	readQueue: vi.fn(async () => h.queue),
}));

afterEach(() => {
	cleanup();
	h.listeners.clear();
	h.drainedListeners.clear();
	h.queue = [];
});

const slot = (assigneeName: string | null, status = "open") => ({
	id: "s1",
	status,
	assigneeName,
	assigneeId: assigneeName ? "a" : null,
	assigneeGuestId: null,
});
const snap = (name: string | null) => ({
	meeting: { id: "m1" },
	slots: [slot(name, name ? "claimed" : "open")],
});
const op: RoleSlotOp = {
	type: "assignSlot",
	opId: "o1",
	queuedAt: 1,
	slotId: "s1",
	roleName: "Timer",
	memberId: "bob",
	memberDisplayName: "Bob",
	actorMemberId: "adm",
	expectedHolder: null,
	expectedHolderName: null,
};

function hook(fetcher: () => Promise<ReturnType<typeof snap>>) {
	const qc = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: qc }, children);
	const view = renderHook(
		() => useLiveMeeting(snap(null), ["c", "m"], fetcher),
		{ wrapper },
	);
	return { view, qc };
}

const flush = () => act(async () => void (await Promise.resolve()));
const never = () => new Promise<ReturnType<typeof snap>>(() => {});
const nameOf = (view: {
	result: { current: { slots: { assigneeName: string | null }[] } };
}) => view.result.current.slots[0]?.assigneeName;

describe("useLiveMeeting projection (#1638)", () => {
	// protects=the deck shows a queued role edit on mount and on a broadcast,
	//   with no network;
	// fails_when=the queue is not read on mount or on a broadcast, or the read
	//   waits on the refetch (this fetcher never resolves);
	// no_claim=the 30s poll (use-live-meeting.test.ts).
	it("shows a queued assign on mount and after a broadcast, without a fetch", async () => {
		h.queue = [op];
		const { view } = hook(vi.fn(never));
		await flush();
		expect(nameOf(view)).toBe("Bob");

		h.queue = [];
		await act(async () => {
			for (const cb of h.listeners) cb();
			await Promise.resolve();
		});
		expect(nameOf(view)).toBeNull();
	});

	// protects=the queue is re-read after every poll (a drain in another tab, or
	//   an op queued while a refetch was in flight, shows without a broadcast);
	// fails_when=the post-poll read is removed;
	// no_claim=that the poll's own data is right.
	it("re-reads the queue after a poll", async () => {
		const { view, qc } = hook(async () => snap(null));
		await flush();
		expect(nameOf(view)).toBeNull();
		h.queue = [op];
		await act(async () => {
			await qc.refetchQueries();
		});
		await flush();
		expect(nameOf(view)).toBe("Bob");
	});

	// protects=queued ops sit on top of the NEWEST server copy, and on the last
	//   good copy when a poll fails;
	// fails_when=a newer server holder replaces the queued one, or a failed poll
	//   drops the projection;
	// no_claim=reconciling a drained op (the overlay tests).
	it("projects over the newest server copy, and over the last good one when a poll fails", async () => {
		h.queue = [op];
		let fail = false;
		const { view, qc } = hook(async () => {
			if (fail) throw new Error("offline");
			return snap("Zed");
		});
		await flush();
		await act(async () => {
			await qc.refetchQueries();
		});
		await flush();
		expect(nameOf(view)).toBe("Bob");
		fail = true;
		await act(async () => {
			await qc.refetchQueries();
		});
		await flush();
		expect(nameOf(view)).toBe("Bob");
	});

	// protects=no flash back to the stale name between the dequeue and the
	//   refetch;
	// fails_when=a drained op stops projecting before a later read lands;
	// no_claim=the overlay's end (next tests).
	it("keeps projecting a drained op until a read after it succeeds", async () => {
		const { view } = hook(vi.fn(never));
		await flush();
		const entry: DrainedRoleOp = {
			op,
			outcome: "applied",
			currentHolderName: null,
		};
		await act(async () => {
			for (const cb of h.drainedListeners) cb([entry], Date.now());
		});
		expect(nameOf(view)).toBe("Bob");
	});

	// protects=the overlay ends once a read that STARTED after the dequeue
	//   succeeds, and not before;
	// fails_when=the overlay never drops (a stale name sticks), or it drops on a
	//   read that began before the dequeue;
	// no_claim=the read being right: the fetcher here returns the open copy.
	it("drops the overlay on a read that started after the dequeue, keeps it on an older one", async () => {
		const entry: DrainedRoleOp = {
			op,
			outcome: "applied",
			currentHolderName: null,
		};
		// An older read: the drain announced it a minute from now.
		{
			const { view, qc } = hook(async () => snap(null));
			await flush();
			await act(async () => {
				for (const cb of h.drainedListeners) cb([entry], Date.now() + 60_000);
			});
			await act(async () => {
				await qc.refetchQueries();
			});
			await flush();
			expect(nameOf(view)).toBe("Bob");
			cleanup();
			h.drainedListeners.clear();
			h.listeners.clear();
		}
		// A later read: the dequeue was a minute ago.
		const { view, qc } = hook(async () => snap(null));
		await flush();
		await act(async () => {
			for (const cb of h.drainedListeners) cb([entry], Date.now() - 60_000);
		});
		expect(nameOf(view)).toBe("Bob");
		await act(async () => {
			await qc.refetchQueries();
		});
		await flush();
		expect(nameOf(view)).toBeNull();
	});

	// protects=R10: a skipped drained op leaves the server copy as it is (a name
	//   over the old holder's speech and ids would show a slot that never
	//   existed), and a removed slot disappears;
	// fails_when=a skipped op rewrites assigneeName, or slot-gone renders as an
	//   open row;
	// no_claim=the refetch that then shows the real holder.
	it("a skipped drained op projects nothing; a slot-gone one hides the row", async () => {
		const { view } = hook(vi.fn(never));
		await flush();
		await act(async () => {
			for (const cb of h.drainedListeners)
				cb(
					[
						{
							op,
							outcome: "skipped",
							reason: "holder-changed",
							currentHolderName: "Zed",
						} satisfies DrainedRoleOp,
					],
					Date.now(),
				);
		});
		expect(nameOf(view)).toBeNull();
		expect(view.result.current.slots).toHaveLength(1);
		await act(async () => {
			for (const cb of h.drainedListeners)
				cb(
					[
						{
							op,
							outcome: "skipped",
							reason: "slot-gone",
							currentHolderName: null,
						} satisfies DrainedRoleOp,
					],
					Date.now(),
				);
		});
		expect(view.result.current.slots).toHaveLength(0);
	});
});
