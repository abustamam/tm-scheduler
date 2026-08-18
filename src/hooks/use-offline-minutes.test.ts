// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real constant, never a local copy: a test that re-declares the deadline
// still passes when the shipped one is raised to ten minutes.
import { ONLINE_WRITE_TIMEOUT_MS } from "#/lib/offline-write-deadline";

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
	// `READ_FAILS` reaches the one branch a return value cannot: `indexedDB.open`
	// REJECTING (Safari private browsing). That path used to be swallowed, which
	// made a failed read indistinguishable from a first visit — see the
	// "surfaces a failed persisted load" test below.
	readQueue: async () => {
		if (READ_FAILS) throw new Error("IDB blocked");
		return QUEUED;
	},
	// Same reason `QUEUED` is a variable: the persisted SNAPSHOT is what the
	// attendance panel's offline projection falls back to, so a test needs to be
	// able to tell one meeting's saved snapshot from another's.
	readSnapshot: async () => {
		if (READ_FAILS) throw new Error("IDB blocked");
		return SNAPSHOT;
	},
	saveSnapshot: async () => {},
	removeOp: (...args: unknown[]) => removeOpSpy(...args),
}));
// The hook reads connectivity itself, so the test drives it here rather than
// through a prop — which also proves the hook is not silently trusting a caller.
let ONLINE = true;
let QUEUED: unknown[] = [];
let READ_FAILS = false;
let SNAPSHOT: unknown = null;
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

/** A SECOND op with a distinct `opId`, so a test can tell whose queue is whose:
 *  `op-1` belongs to the meeting that was left, `op-2` to the one arrived at. */
const OP2 = () => ({
	type: "setAttendance" as const,
	opId: "op-2",
	queuedAt: 2,
	memberId: "m2",
	status: "absent" as const,
});

/** Shape-only stand-in for the loader's `MinutesData`, one per meeting so a test
 *  can say WHOSE minutes are on screen. Typed off the hook's own input so it
 *  cannot drift, and so this file still needs no `#/server/*` import (that module
 *  chain reaches `#/db`). */
const minutesFixture = (label: string) =>
	({ label, members: [], guests: [] }) as unknown as NonNullable<
		Parameters<typeof useOfflineMinutes>[0]["minutes"]
	>;
const MINUTES_A = minutesFixture("meet-1");

/**
 * Advance the FAKE clock in steps until `done()` holds, or give up after 20
 * seconds of virtual time. One `advanceTimersByTimeAsync(20_000)` is not
 * equivalent: the chains under test alternate between promise hops and React
 * commits, and each step here lets the render land before the next tick. Purely
 * virtual, so it costs no real time and cannot flake on a loaded machine.
 */
async function tickUntil(done: () => boolean) {
	for (let i = 0; i < 20 && !done(); i++) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
	}
}

describe("useOfflineMinutes", () => {
	beforeEach(() => {
		enqueueSpy.mockClear();
		removeOpSpy.mockClear();
		QUEUED = [];
		READ_FAILS = false;
		SNAPSHOT = null;
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
	it("keeps one meeting's queued ops out of another meeting's queue (F1)", async () => {
		// The data-corruption fix. `meetingId` is a PROP and the meeting route is
		// NOT remounted when its param changes (nothing sets `remountDeps`), so a
		// tap on the meeting nav strip changes it with every piece of this hook's
		// state intact. The persisted load used to MERGE, so meeting A's still-
		// queued ops survived into meeting B and `runDrain` replayed them with B's
		// id — last week's roll written onto this meeting, silently.
		ONLINE = false;
		const { result, rerender } = renderHook(
			({ id }: { id: string }) =>
				useOfflineMinutes({ meetingId: id, onMutated: async () => {} }),
			{ initialProps: { id: "meet-1" } },
		);

		await act(async () => {
			await result.current.mutate(async () => {}, OP);
		});
		expect(result.current.queue).toHaveLength(1);

		// Hop. Meeting B has its OWN saved queue, so "replace, don't merge" is
		// observable as WHICH op is in hand rather than merely as a count.
		QUEUED = [OP2()];
		rerender({ id: "meet-2" });

		// Synchronously — before the persisted load for B has even started. The
		// auto-drain effect runs on this very commit, so a queue still holding A's
		// ops here is already dispatchable against B's id.
		expect(result.current.queue).toHaveLength(0);

		await waitFor(
			() => expect(result.current.queue).toHaveLength(1),
			WAIT_OPTS,
		);
		expect(result.current.queue[0].opId).toBe("op-2");

		// And the drain replays B's op ONLY. This half is deliberately positive as
		// well as negative: `removeOp` proves a drain really ran (so the negative
		// assertion below cannot pass vacuously), and proves it carried B's id.
		ONLINE = true;
		rerender({ id: "meet-2" });
		await waitFor(
			() => expect(removeOpSpy).toHaveBeenCalledWith("meet-2", "op-2"),
			WAIT_OPTS,
		);
		expect(removeOpSpy).not.toHaveBeenCalledWith("meet-2", "op-1");
		expect(removeOpSpy).toHaveBeenCalledTimes(1);
	});

	it("drops the previous meeting's snapshot on a hop, even when the next load fails (F5)", async () => {
		// The READ side of the same root cause. `snapshot` is what the attendance
		// panel's offline projection falls back to, so a retained one renders
		// another meeting's rows, guests and counts under this meeting's heading —
		// coherently, with nothing on any surface saying so.
		//
		// The hop here lands on a load that REJECTS (`indexedDB.open` in Safari
		// private browsing), which is the case a reset written into the load's
		// success path cannot cover — and the case the old bare `.catch(() => {})`
		// made invisible. Hence the reset is a render-phase one.
		ONLINE = true;
		SNAPSHOT = MINUTES_A;
		const { result, rerender } = renderHook(
			({ id }: { id: string }) =>
				useOfflineMinutes({ meetingId: id, onMutated: async () => {} }),
			{ initialProps: { id: "meet-1" } },
		);

		await waitFor(
			() => expect(result.current.snapshot).toBe(MINUTES_A),
			WAIT_OPTS,
		);

		READ_FAILS = true;
		rerender({ id: "meet-2" });
		// Immediately, and then for good: the failed load never gets to reset it.
		expect(result.current.snapshot).toBeNull();
		await waitFor(
			() => expect(result.current.syncError).toBe("IDB blocked"),
			WAIT_OPTS,
		);
		expect(result.current.snapshot).toBeNull();
	});

	it("surfaces a failed persisted load instead of looking like a first visit (F5)", async () => {
		// A rejected `indexedDB.open` used to be swallowed whole, leaving an empty
		// queue and no snapshot — the same state as a first visit. That silence is
		// what turns a read error into a data bug: the officer takes roll against a
		// clean panel while the changes saved on this device are unread.
		READ_FAILS = true;
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		await waitFor(
			() => expect(result.current.syncError).toBe("IDB blocked"),
			WAIT_OPTS,
		);
	});

	it("lets Retry clear a banner the failed load raised with nothing queued", async () => {
		// `runDrain` returns immediately on an empty queue, so without this the
		// banner the test above asserts would have a Retry button that provably
		// cannot do anything.
		READ_FAILS = true;
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);
		await waitFor(
			() => expect(result.current.syncError).not.toBeNull(),
			WAIT_OPTS,
		);

		await act(async () => {
			await result.current.retryDrain();
		});

		expect(result.current.syncError).toBeNull();
	});
	it("stops waiting on a write the network never answers, and queues the tap (F2)", async () => {
		// `navigator.onLine` is TRUE on a captive portal or dead venue wifi — the
		// exact conditions #176 exists for — so this took the ONLINE branch, awaited
		// a promise that never settles, and never reached its `finally`: `busy`
		// stuck true forever, which the panel faithfully renders as every chip and
		// the guest group disabled, with no spinner, no toast and no way back short
		// of a reload.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			const hang = vi.fn(() => new Promise<unknown>(() => {}));
			const { result } = renderHook(() =>
				useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
			);
			await tickUntil(() => true);

			let pending!: Promise<void>;
			await act(async () => {
				pending = result.current.mutate(hang, OP);
			});
			// The write really did go out online — otherwise the assertions below
			// would hold for a version that simply never tried.
			expect(hang).toHaveBeenCalledTimes(1);
			expect(result.current.busy).toBe(true);

			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});

			expect(result.current.busy).toBe(false);
			// The tap is not lost: it went into the durable queue for this meeting.
			expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
			// And it is genuinely replayable — asserted rather than assumed, because
			// `queue` is transient here: the auto-drain sees a queue with
			// `navigator.onLine` true and replays it against the (mocked, answering)
			// server straight away, which is exactly the recovery this path is for.
			await tickUntil(() => removeOpSpy.mock.calls.length > 0);
			expect(removeOpSpy).toHaveBeenCalledWith("meet-1", "op-1");
			expect(result.current.queue).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops a DRAIN the network never answers, instead of disabling the panel forever (F2)", async () => {
		// The other half of the same fix. Deadlining only the write moves the hang
		// rather than closing it: the timed-out tap is queued, the auto-drain fires
		// the moment it sees a queue with `navigator.onLine` true, the replay hits
		// the same unreachable network, and `draining` — which the panel also
		// disables every control on — never clears.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			QUEUED = [OP()];
			openDispatchGate(); // never resolved: the replay hangs like a portal
			const { result } = renderHook(() =>
				useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
			);

			await tickUntil(() => result.current.draining);
			expect(result.current.draining).toBe(true);

			await tickUntil(() => !result.current.draining);

			expect(result.current.draining).toBe(false);
			expect(result.current.syncError).toBe("No response from the network.");
			// Stop-on-failure: the op stays queued and Retry can replay it.
			expect(result.current.queue).toHaveLength(1);
			expect(removeOpSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT queue a write the server actively rejected", async () => {
		// The distinction the timeout path must not blur. A 403, or a rejected
		// `assertAttendanceRecordable`, will be rejected identically on every
		// replay — queueing it turns one toast into a permanently stuck queue and a
		// sync-error banner the officer cannot clear.
		ONLINE = true;
		const rejects = vi.fn(async () => {
			throw new Error("Forbidden");
		});
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		await act(async () => {
			await result.current.mutate(rejects, OP);
		});

		expect(rejects).toHaveBeenCalledTimes(1);
		expect(enqueueSpy).not.toHaveBeenCalled();
		expect(result.current.queue).toHaveLength(0);
		expect(result.current.busy).toBe(false);
	});

	it("keeps its deadline shorter than the wait it replaced", () => {
		// A sanity tie between the hook and the constant it imports: if this ever
		// reads Infinity/NaN the two tests above would hang or pass vacuously.
		expect(Number.isFinite(ONLINE_WRITE_TIMEOUT_MS)).toBe(true);
		expect(ONLINE_WRITE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});
