// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `waitFor`'s 1000ms default is sized for an isolated run. This file's mount
// effects are real async chains (a dynamic import among them), and running
// this suite alongside the other DB-touching/import-heavy files in this repo
// under CPU contention has measurably pushed that chain past 1000ms — a
// `waitFor` timeout there is the environment, not the hook being wrong (same
// contention class `vitest.config.ts` widens its own DB-suite timeouts for).
const WAIT_OPTS = { timeout: 5000 };

const enqueueSpy = vi.fn(async (..._args: unknown[]) => {});
const removeOpSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock("#/lib/offline-minutes-queue", () => ({
	enqueue: (...args: unknown[]) => enqueueSpy(...args),
	readQueue: async () => QUEUED,
	readSnapshot: async () => null,
	saveSnapshot: async () => {},
	removeOp: (...args: unknown[]) => removeOpSpy(...args),
}));
// The hook reads connectivity itself, so the test drives it here rather than
// through a prop — which also proves the hook is not silently trusting a caller.
let ONLINE = true;
let QUEUED: unknown[] = [];
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => ONLINE,
	useOfflineReady: () => true,
}));

// The drain's dispatch table is loaded via `import("#/server/minutes")` inside
// the hook (see use-offline-minutes.ts's doc comment for why that import is
// lazy). Mocked here — rather than left to fail on the unmocked `#/db` import
// it would otherwise transitively pull in — for two reasons: (1) leaving it
// unmocked made the "drain in flight" test's determinism rest on how long
// that failing import takes to reject, which is transform/environment
// latency, not anything the hook controls (M4, review); (2) it is the only
// way to exercise a drain that actually SUCCEEDS, which no test here did
// before. `setAttendance` is gated behind `dispatchGate` so a test can hold
// the drain open on purpose instead of racing it.
let dispatchGate: { promise: Promise<void>; resolve: () => void } | null = null;
function openDispatchGate() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	dispatchGate = { promise, resolve };
	return dispatchGate;
}
vi.mock("#/server/minutes", () => ({
	setAttendance: vi.fn(async () => {
		if (dispatchGate) await dispatchGate.promise;
		return {};
	}),
	addMinutesGuest: vi.fn(async () => ({})),
	removeMinutesGuest: vi.fn(async () => ({})),
	addTableTopics: vi.fn(async () => ({})),
	removeTableTopics: vi.fn(async () => ({})),
	moveTableTopics: vi.fn(async () => ({})),
	setMinutesAward: vi.fn(async () => ({})),
	clearMinutesAward: vi.fn(async () => ({})),
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
		removeOpSpy.mockClear();
		QUEUED = [];
		dispatchGate = null;
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

	it("queues the op and does NOT call the server when offline", async () => {
		// Dedicated regression coverage for a pre-existing race (found via THIS
		// test): `mutate()`'s optimistic `setQueue` ran synchronously right after
		// mount, before the mount-time persisted-queue load (also kicked off on
		// mount, async) had resolved. The load used to unconditionally
		// `setQueue(savedQueue)` on resolution, silently reverting this
		// optimistic update the instant it landed — a real bug in the ORIGINAL
		// `meeting-minutes.tsx`, just never exercised there (no test in
		// `meeting-minutes.test.tsx` calls `mutate()`). The hook's mount effect
		// now merges instead of overwriting.
		const onlineFn = vi.fn(async () => {});
		ONLINE = false;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		expect(onlineFn).not.toHaveBeenCalled();
		expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
		expect(result.current.queue).toHaveLength(1);
	});

	it("refuses to start a write while a drain is in flight", async () => {
		// The ordering guard. Without it a reconnect drain interleaves with a fresh
		// edit and the two land out of order — the queue replays a stale status over
		// a newer one, silently.
		// Driven through the hook's REAL drain, not a test-only setter. Seed a
		// persisted queue so the mount-time drain starts and sets `draining` itself,
		// then assert a fresh write is refused while it runs. The dispatch gate
		// (opened below) holds the drain open deterministically — no `waitFor`
		// timeout race and no reliance on how many microtask ticks a mount effect
		// happens to need.
		//
		// No `__setDrainingForTest` backdoor: an API that exists only so a test can
		// reach it lets the guard be deleted while the test still passes.
		const onlineFn = vi.fn(async () => {});
		ONLINE = true;
		QUEUED = [OP()]; // readQueue returns this, so the drain has work on mount
		const gate = openDispatchGate();
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		// Let the mount-time persisted-queue load resolve and the auto-drain
		// effect start the REAL drain, which now blocks inside the mocked
		// `setAttendance` on `gate.promise` — so `draining` stays true until this
		// test releases it, deterministically.
		await waitFor(() => expect(result.current.draining).toBe(true), WAIT_OPTS);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		// The drain owns the queue for the duration; a concurrent write would let
		// the replay reorder against it and land a stale status over a newer one.
		expect(onlineFn).not.toHaveBeenCalled();

		// Release the gate so the drain finishes rather than leaking a pending
		// promise/timer into the next test.
		gate.resolve();
		await waitFor(() => expect(result.current.draining).toBe(false), WAIT_OPTS);
	});

	it("completes a drain: empties the queue, clears syncError, and calls onMutated", async () => {
		// The companion to the test above — that one proves the IN-FLIGHT guard;
		// this one proves the drain this hook exists for actually lands. Without
		// it, "refuses to start a write while a drain is in flight" could pass
		// against a drain that can never successfully finish (for instance the
		// pre-fix version of this suite, where the auto-drain always failed on
		// the unmocked `#/db` import and `draining` only ever flipped false via
		// the failure path).
		// Gated exactly like the test above, rather than letting the mock
		// dispatch resolve freely: polling for the TRANSIENT `draining === true`
		// moment against a dispatch that can resolve in well under one poll
		// interval is itself a timing race — it passed reliably alone and failed
		// solidly (not flakily) once this file ran alongside this repo's other
		// suites, where the resolution turned out to be fast enough to land
		// between polls. The gate makes "the drain started" an observable fact
		// under test control instead of a race against how fast a mock resolves.
		const onMutated = vi.fn(async () => {});
		ONLINE = true;
		QUEUED = [OP()];
		const gate = openDispatchGate();
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated }),
		);

		await waitFor(() => expect(result.current.draining).toBe(true), WAIT_OPTS);

		gate.resolve();

		await waitFor(() => expect(result.current.draining).toBe(false), WAIT_OPTS);

		expect(result.current.queue).toHaveLength(0);
		expect(result.current.syncError).toBeNull();
		expect(onMutated).toHaveBeenCalledTimes(1);
		expect(removeOpSpy).toHaveBeenCalledWith("meet-1", "op-1");
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
