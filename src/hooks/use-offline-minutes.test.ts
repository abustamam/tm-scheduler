// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock("#/lib/offline-minutes-queue", () => ({
	enqueue: (...args: unknown[]) => enqueueSpy(...args),
	readQueue: async () => QUEUED,
	readSnapshot: async () => null,
	saveSnapshot: async () => {},
}));
// The hook reads connectivity itself, so the test drives it here rather than
// through a prop — which also proves the hook is not silently trusting a caller.
let ONLINE = true;
let QUEUED: unknown[] = [];
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => ONLINE,
	useOfflineReady: () => true,
}));

const { useOfflineMinutes } = await import("#/hooks/use-offline-minutes");

const OP = () => ({
	type: "setAttendance" as const,
	opId: "op-1",
	queuedAt: 1,
	memberId: "m1",
	status: "present" as const,
});

describe("useOfflineMinutes", () => {
	beforeEach(() => {
		enqueueSpy.mockClear();
		QUEUED = [];
	});

	it("runs the online fn and refreshes when online", async () => {
		const onlineFn = vi.fn(async () => {});
		const onMutated = vi.fn(async () => {});
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated }),
		);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		expect(onlineFn).toHaveBeenCalledTimes(1);
		expect(onMutated).toHaveBeenCalledTimes(1);
		// The ONLINE path must never touch the queue. A regression that enqueued
		// unconditionally would still pass a "did the write happen" assertion.
		expect(enqueueSpy).not.toHaveBeenCalled();
	});

	it("refuses to start a write while a drain is in flight", async () => {
		// The ordering guard. Without it a reconnect drain interleaves with a fresh
		// edit and the two land out of order — the queue replays a stale status over
		// a newer one, silently.
		// Driven through the hook's REAL drain, not a test-only setter. Seed a
		// persisted queue so the mount-time drain starts and sets `draining` itself,
		// then assert a fresh write is refused while it runs.
		//
		// No `__setDrainingForTest` backdoor: an API that exists only so a test can
		// reach it lets the guard be deleted while the test still passes. If the
		// drain proves non-deterministic in jsdom, report DONE_WITH_CONCERNS with
		// what you tried and assert something narrower — do NOT add a backdoor.
		const onlineFn = vi.fn(async () => {});
		ONLINE = true;
		QUEUED = [OP()]; // readQueue returns this, so the drain has work on mount
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		// Let the mount-time persisted-queue load resolve and the auto-drain
		// effect start the REAL drain before touching `mutate` — calling `mutate`
		// in the same synchronous tick as `renderHook` would race the drain's own
		// async mount effects and observe `draining` before it ever flips (a
		// timing artifact of the test, not of the hook), so the flush below
		// drives the hook's actual drain to the point where `draining` is true
		// rather than asserting on a startup instant nothing else observes.
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current.draining).toBe(true);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		// The drain owns the queue for the duration; a concurrent write would let
		// the replay reorder against it and land a stale status over a newer one.
		expect(onlineFn).not.toHaveBeenCalled();
	});

	it("stamps each op with a distinct id", () => {
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);
		// Two ops queued in the same tick must not collide — the drain de-dups on
		// opId, so a shared id silently drops one of them.
		expect(result.current.opMeta().opId).not.toBe(result.current.opMeta().opId);
	});
});
