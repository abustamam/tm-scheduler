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
	return renderHook(() => useLiveMeeting(snap(null), ["c", "m"], fetcher), {
		wrapper,
	});
}

const flush = () => act(async () => void (await Promise.resolve()));

describe("useLiveMeeting projection (#1638)", () => {
	// protects=the deck shows a queued role edit on mount and on a broadcast,
	// with no network; fails_when=the queue is not read, or waits on the refetch;
	// no_claim=the 30s poll (use-live-meeting.test.ts).
	it("shows a queued assign on mount and after a broadcast, without a fetch", async () => {
		const fetcher = vi.fn(() => new Promise<ReturnType<typeof snap>>(() => {}));
		h.queue = [op];
		const view = hook(fetcher);
		await flush();
		expect(view.result.current.slots[0]?.assigneeName).toBe("Bob");

		h.queue = [];
		await act(async () => {
			for (const cb of h.listeners) cb();
			await Promise.resolve();
		});
		expect(view.result.current.slots[0]?.assigneeName).toBeNull();
	});

	// protects=no flash back to the stale name between dequeue and refetch;
	// fails_when=a drained op stops projecting before a later read lands.
	it("keeps projecting a drained op until a read after it succeeds", async () => {
		const fetcher = vi.fn(() => new Promise<ReturnType<typeof snap>>(() => {}));
		const view = hook(fetcher);
		await flush();
		const entry: DrainedRoleOp = {
			op,
			outcome: "applied",
			currentHolderName: null,
		};
		await act(async () => {
			for (const cb of h.drainedListeners) cb([entry], Date.now());
		});
		expect(view.result.current.slots[0]?.assigneeName).toBe("Bob");
	});

	it("a skipped drained op shows who holds the slot now", async () => {
		const fetcher = vi.fn(() => new Promise<ReturnType<typeof snap>>(() => {}));
		const view = hook(fetcher);
		await flush();
		const entry: DrainedRoleOp = {
			op,
			outcome: "skipped",
			currentHolderName: "Zed",
		};
		await act(async () => {
			for (const cb of h.drainedListeners) cb([entry], Date.now());
		});
		expect(view.result.current.slots[0]?.assigneeName).toBe("Zed");
	});
});
