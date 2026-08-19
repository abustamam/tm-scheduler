// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real constant, never a local copy: a test that re-declares the deadline
// still passes when the shipped one is raised to ten minutes.
import { ONLINE_WRITE_TIMEOUT_MS } from "#/lib/offline-write-deadline";
// The production projection, so the one test that asserts what the officer's CHIP
// says reads it through the same function the meeting route does rather than a
// re-derivation that could agree with a bug.
import { projectMinutes } from "#/lib/project-minutes";

// `waitFor`'s 1000ms default is sized for an isolated run. This file's mount
// effects are real async chains (a dynamic import among them), and running
// this suite alongside the other DB-touching/import-heavy files in this repo
// under CPU contention has measurably pushed that chain past 1000ms — a
// `waitFor` timeout there is the environment, not the hook being wrong (same
// contention class `vitest.config.ts` widens its own DB-suite timeouts for).
const WAIT_OPTS = { timeout: 5000 };

/** One real task boundary. `await Promise.resolve()` is not equivalent: React
 *  batches updates that land in the same task, so a mock that only yields
 *  microtasks can coalesce two commits the real code produces separately. */
const ioBoundary = () => new Promise<void>((r) => setTimeout(r, 0));

const enqueueSpy = vi.fn(async (..._args: unknown[]) => {
	if (ENQUEUE_FAILS) throw new Error("IDB write blocked");
});
/** A REAL spy, not the bare no-op it was: the snapshot-freshness effect
 *  (`[online, minutes, meetingId]`) was exercised by nothing at all, and the
 *  hook's own comment calls omitting that effect "a silent regression". */
const saveSnapshotSpy = vi.fn(async (..._args: unknown[]) => {});
/**
 * GENUINELY async, deliberately. The F2 drop only exists when the `setQueue`
 * commit and the final `setDraining(false)` commit land in SEPARATE React
 * commits, which real IndexedDB and a real `router.invalidate()` guarantee — a
 * fully-synchronous mock batches them into one and the test then PASSES against
 * the bug. Every test in this file pays one 0ms timer per drained op for it.
 */
const removeOpSpy = vi.fn(async (..._args: unknown[]) => {
	await ioBoundary();
});
vi.mock("#/lib/offline-minutes-queue", () => ({
	enqueue: (...args: unknown[]) => enqueueSpy(...args),
	// `READ_FAILS` reaches the one branch a return value cannot: `indexedDB.open`
	// REJECTING (Safari private browsing). That path used to be swallowed, which
	// made a failed read indistinguishable from a first visit — see the
	// "surfaces a failed persisted load" test below.
	readQueue: async () => {
		// Counted, not just returned: F6's fix is that Retry RE-READS, and the only
		// observable for "the load effect ran again" is that the store was asked
		// again — the returned value is identical either way.
		READ_COUNT += 1;
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
	saveSnapshot: (...args: unknown[]) => saveSnapshotSpy(...args),
	removeOp: (...args: unknown[]) => removeOpSpy(...args),
}));
// The hook reads connectivity itself, so the test drives it here rather than
// through a prop — which also proves the hook is not silently trusting a caller.
let ONLINE = true;
let QUEUED: unknown[] = [];
let READ_FAILS = false;
let READ_COUNT = 0;
let ENQUEUE_FAILS = false;
let SNAPSHOT: unknown = null;
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => ONLINE,
	useOfflineReady: () => true,
}));

// Spied rather than left real: the deadline's toast is the one piece of this
// hook's behaviour that has to be ABSENT after unmount (F7), and an absence is
// not observable through the real sonner store.
const toastErrorSpy = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => toastErrorSpy(...args),
		success: vi.fn(),
		message: vi.fn(),
	},
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
/** Named rather than inline so a test can count DISPATCHES — the observable that
 *  makes "the `!syncError` gate is what stops a tight loop" assertable at all. */
const setAttendanceSpy = vi.fn(async () => {
	if (dispatchGate) await dispatchGate.promise;
	return {};
});
vi.mock("#/server/minutes", () => ({
	setAttendance: (...args: unknown[]) =>
		(setAttendanceSpy as (...a: unknown[]) => Promise<unknown>)(...args),
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
 * A REAL `MinutesData` (not the shape-only stand-in above), needed by the one
 * test that reads what the officer's CHIP would say rather than only what the
 * hook returns. `projectMinutes` is the production projection the meeting route
 * calls, and it `structuredClone`s and recomputes over these fields — so a
 * `{ members: [] }` stub cannot stand in. Import-safe for the same reason
 * `derive-minutes.ts` is: its `#/server/minutes-logic` import is TYPE-ONLY, so
 * nothing here reaches `#/db`.
 */
const ROLL_SNAPSHOT = {
	members: [{ memberId: "m1", name: "Jane", status: "unmarked" }],
	guests: [],
	tableTopicsSpeakers: [],
	awards: [],
	actionItems: [],
	counts: { present: 0, absent: 0, excused: 0, unmarked: 1, guests: 0 },
	awardEligible: {},
} as unknown as NonNullable<Parameters<typeof useOfflineMinutes>[0]["minutes"]>;

/**
 * What the roll chip for Jane would render, projected through the SAME function
 * the meeting route uses. `online` is a parameter because the two matter for
 * different reasons: online proves the projection replays a non-empty queue even
 * though `navigator.onLine` is true (the state a deadlined write leaves behind),
 * offline proves it falls back to the persisted snapshot.
 */
function statusOnChip(
	queue: unknown[],
	online: boolean,
): string | null | undefined {
	const projected = projectMinutes({
		online,
		minutes: ROLL_SNAPSHOT,
		snapshot: ROLL_SNAPSHOT,
		queue: queue as Parameters<typeof projectMinutes>[0]["queue"],
	});
	return projected?.members.find((m) => m.memberId === "m1")?.status;
}

/**
 * THE SERVER, folded last-write-wins out of the one ordered log of everything it
 * was told. Both write channels — the drain's replay and a direct online write —
 * go through the same mocked `setAttendance`, so `mock.calls` is that log in
 * arrival order, and `setAttendance` really is an `onConflictDoUpdate` upsert
 * (`minutes-logic.ts`), so "last call wins" is the server's actual semantics.
 *
 * Asserting the FOLD is the whole point of the G1 test: the bug and the fix issue
 * the SAME set of writes and differ only in their order, so any assertion on a
 * call count — or on the mere presence of the newer write — passes against both.
 */
function lastServerStatusFor(memberId: string): string | undefined {
	let status: string | undefined;
	for (const call of setAttendanceSpy.mock.calls as unknown as Array<
		[{ data: { memberId: string; status: string } }]
	>) {
		if (call[0]?.data?.memberId === memberId) status = call[0].data.status;
	}
	return status;
}

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
		setAttendanceSpy.mockClear();
		saveSnapshotSpy.mockClear();
		toastErrorSpy.mockClear();
		QUEUED = [];
		READ_FAILS = false;
		READ_COUNT = 0;
		ENQUEUE_FAILS = false;
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

	it("does NOT push a DEADLINED write into the meeting the officer hopped to (F1)", async () => {
		// The corruption the write deadline reopened, and the reason a per-fix
		// mutation test is not enough on this file: the render-phase reset above
		// guards STATE at the moment of the hop, while the deadline creates an
		// in-flight continuation that resumes up to ONLINE_WRITE_TIMEOUT_MS later —
		// long enough for one tap on the meeting nav strip. `queueOp` persists under
		// the meeting its closure CAPTURED but reflected optimistically through a
		// HOOK-LEVEL setter, so meeting A's roll entry landed in meeting B's queue,
		// B's auto-drain dispatched it against B's id, and `removeOp` cleared B's
		// copy — leaving A's still queued to replay against A as well. One tap, two
		// meetings, and the same club, so the server accepted both silently.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			const hang = vi.fn(() => new Promise<unknown>(() => {}));
			const { result, rerender } = renderHook(
				({ id }: { id: string }) =>
					useOfflineMinutes({ meetingId: id, onMutated: async () => {} }),
				{ initialProps: { id: "meet-1" } },
			);
			await tickUntil(() => true);

			let pending!: Promise<void>;
			await act(async () => {
				pending = result.current.mutate(hang, OP);
			});
			// The write really went out ONLINE — without this the assertions below
			// would also hold for a version that queued straight away and never tried.
			expect(hang).toHaveBeenCalledTimes(1);

			// The hop, INSIDE the deadline window: A's write is still in flight.
			rerender({ id: "meet-2" });

			// Now let the deadline fire. `queueOp` resumes with meeting A captured.
			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});

			// A's op persists under A: it is A's roll and must replay against A.
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
			// B's queue never learns about it.
			expect(result.current.queue).toHaveLength(0);
			// And no drain dispatched it against B. `removeOp` is the drain's proof
			// that a dispatch LANDED, so its absence is the absence of the
			// double-write — and the loop gives the auto-drain 20 virtual seconds to
			// prove otherwise rather than asserting on an instant that is too early
			// for the buggy version to have reached it yet.
			await tickUntil(() => removeOpSpy.mock.calls.length > 0);
			expect(removeOpSpy).not.toHaveBeenCalled();
			expect(result.current.queue).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
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

	it("makes Retry RE-READ when the failed load left nothing queued (F6)", async () => {
		// This test asserted the OPPOSITE until F6 — that Retry cleared the banner and
		// that was that. Clearing was the defect: the load effect's deps were
		// `[meetingId]` and it is the only reader of the durable queue, so hiding the
		// banner was Retry's entire effect, returning the officer to the clean-looking
		// panel the same commit calls "what turns a read error into a DATA bug".
		//
		// Retry now re-reads. A read that still fails says so again, which is what a
		// retry looks like; the success path is the test below it.
		READ_FAILS = true;
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);
		await waitFor(
			() => expect(result.current.syncError).not.toBeNull(),
			WAIT_OPTS,
		);
		const readsBefore = READ_COUNT;
		expect(readsBefore).toBeGreaterThan(0);

		await act(async () => {
			await result.current.retryDrain();
		});

		// It asked the store again...
		expect(READ_COUNT).toBeGreaterThan(readsBefore);
		// ...and reports what it found, rather than leaving a cleared banner over an
		// unread queue.
		await waitFor(
			() => expect(result.current.syncError).toBe("IDB blocked"),
			WAIT_OPTS,
		);
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
			// Waits on the OBSERVABLE it asserts, not on a proxy for it: `removeOp`
			// is genuinely async now (see its comment above — F2 needs it to be),
			// so the queue filter lands one task after the call, and waiting for
			// the call alone asserted the queue one tick too early.
			await tickUntil(
				() =>
					removeOpSpy.mock.calls.length > 0 &&
					result.current.queue.length === 0,
			);
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
			// And it stopped ONCE. The auto-drain now also re-fires on `draining`
			// (F2), so the thing standing between a permanent failure and a tight
			// loop against the network is the `!syncError` gate — nothing tested
			// that before. A dispatch count is the only observable for it: the
			// queue, the error and the flag all read identically after one failed
			// attempt and after two hundred. 20 further virtual seconds have
			// already elapsed inside the `tickUntil` above.
			expect(setAttendanceSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drains the NEXT meeting's queue once a drain in flight across the hop finishes (F2)", async () => {
		// `runDrain`'s `if (drainingRef.current || ops.length === 0) return;` is a
		// SILENT drop, and the auto-drain effect — its only automatic caller — had
		// no dependency that changes when a drain releases. So a drain in flight for
		// meeting A, plus a hop to a meeting B that has its own persisted queue,
		// stranded B: `queue: ["op-2"]`, `draining: false`, `syncError: null`, the
		// panel reading "All changes synced." for four seconds and then nothing,
		// forever, with B's roll still on the device.
		//
		// The commits are ordered on purpose: B's persisted queue is awaited BEFORE
		// the gate is released, so `setQueue` and the drain's final
		// `setDraining(false)` are in separate React commits — which is the only
		// arrangement in which the bug exists (see `removeOpSpy`'s comment).
		const onMutated = vi.fn(async () => {
			await ioBoundary();
		});
		ONLINE = true;
		QUEUED = [OP()]; // A's persisted queue
		const gate = openDispatchGate();
		const { result, rerender } = renderHook(
			({ id }: { id: string }) =>
				useOfflineMinutes({ meetingId: id, onMutated }),
			{ initialProps: { id: "meet-1" } },
		);

		await waitFor(() => expect(result.current.draining).toBe(true), WAIT_OPTS);

		// The hop. B has its own persisted queue, and its auto-drain attempt is the
		// one that used to be swallowed by A's in-flight guard.
		QUEUED = [OP2()];
		rerender({ id: "meet-2" });
		await waitFor(
			() => expect(result.current.queue).toHaveLength(1),
			WAIT_OPTS,
		);
		expect(result.current.queue[0].opId).toBe("op-2");
		// Proof the drop really happened rather than the test racing past it: B's op
		// is queued, this hook is online, and nothing has dispatched it.
		expect(removeOpSpy).not.toHaveBeenCalled();

		// Wifi returns for A's drain.
		gate.resolve();

		// B's queue drains WITHOUT another hop, another reload or a Retry tap.
		await waitFor(
			() => expect(removeOpSpy).toHaveBeenCalledWith("meet-2", "op-2"),
			WAIT_OPTS,
		);
		await waitFor(
			() => expect(result.current.queue).toHaveLength(0),
			WAIT_OPTS,
		);
		expect(result.current.syncError).toBeNull();
		expect(result.current.draining).toBe(false);
		// A's own op was removed under A, never under B.
		expect(removeOpSpy).toHaveBeenCalledWith("meet-1", "op-1");
		expect(removeOpSpy).not.toHaveBeenCalledWith("meet-2", "op-1");
	});

	it("keeps a FAILED drain for the previous meeting off the next meeting's banner, and still drains it (F1+F2)", async () => {
		// The interaction, which is what a per-fix mutation test cannot see. F1
		// makes `syncError` meeting-scoped; F2 re-arms the auto-drain when a drain
		// releases. Remove EITHER and this test fails, for different reasons: an
		// ungated `syncError` paints A's failure onto B AND suppresses B's
		// auto-drain (which gates on `!syncError`), while a missing `draining`
		// dependency never re-fires the effect at all.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			QUEUED = [OP()];
			openDispatchGate(); // never resolved: A's replay hangs like a portal
			const { result, rerender } = renderHook(
				({ id }: { id: string }) =>
					useOfflineMinutes({ meetingId: id, onMutated: async () => {} }),
				{ initialProps: { id: "meet-1" } },
			);

			await tickUntil(() => result.current.draining);
			expect(result.current.draining).toBe(true);

			// Hop while A's drain hangs, and let B's persisted load land first.
			QUEUED = [OP2()];
			rerender({ id: "meet-2" });
			await tickUntil(() =>
				result.current.queue.some((o) => o.opId === "op-2"),
			);
			// B's dispatch will answer; A's is the one that hangs.
			dispatchGate = null;

			// A's drain now blows its own deadline and fails.
			await tickUntil(() => !result.current.draining);

			// B's banner says nothing about A. Without F1's gate this reads
			// "No response from the network." on a meeting that never asked.
			expect(result.current.syncError).toBeNull();
			// And B's queue drains anyway.
			await tickUntil(() =>
				removeOpSpy.mock.calls.some(
					(c) => c[0] === "meet-2" && c[1] === "op-2",
				),
			);
			expect(removeOpSpy).toHaveBeenCalledWith("meet-2", "op-2");
			expect(result.current.queue).toHaveLength(0);
			expect(result.current.justSynced).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-enables the next meeting's roll surface after a hop taken mid-write (F4)", async () => {
		// The render-phase reset cleared `queue`, `snapshot`, `syncError` and
		// `justSynced` — not `busy`. The route wires
		// `busy={offlineMinutes.busy || offlineMinutes.draining}` into the panel's
		// `locked`, so a hop during a stalled write left meeting B's whole roll
		// surface disabled for the rest of A's deadline, and `mutate` refused
		// silently on top of that.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			const hang = vi.fn(() => new Promise<unknown>(() => {}));
			const { result, rerender } = renderHook(
				({ id }: { id: string }) =>
					useOfflineMinutes({ meetingId: id, onMutated: async () => {} }),
				{ initialProps: { id: "meet-1" } },
			);
			await tickUntil(() => true);

			let pending!: Promise<void>;
			await act(async () => {
				pending = result.current.mutate(hang, OP);
			});
			expect(result.current.busy).toBe(true);

			rerender({ id: "meet-2" });

			// The surface is live again immediately — not in eight seconds' time.
			expect(result.current.busy).toBe(false);
			// And a write on B is accepted rather than swallowed by the stale guard.
			const bWrite = vi.fn(async () => {});
			await act(async () => {
				await result.current.mutate(bWrite, OP2);
			});
			expect(bWrite).toHaveBeenCalledTimes(1);

			// Drain A's abandoned write so no timer or promise leaks into the next
			// test, and confirm it still landed under A (F1).
			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});
			expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
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

	it("re-READS the persisted queue when Retry follows a failed load, not just clears the banner (F6)", async () => {
		// Retry's whole effect on a failed-read banner used to be hiding it. The load
		// effect's deps were `[meetingId]`, and it is the ONLY reader of the durable
		// queue, so the justification — "it re-arms the auto-drain for the moment a
		// queue does appear" — described a moment that could never arrive: nothing
		// would ever have looked. The officer's changes stayed unread on the device
		// behind a clean-looking panel, which is the very state the same commit
		// describes as "what turns a read error into a DATA bug".
		READ_FAILS = true;
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);
		await waitFor(
			() => expect(result.current.syncError).not.toBeNull(),
			WAIT_OPTS,
		);
		// Nothing has been read yet, so nothing can have drained.
		expect(removeOpSpy).not.toHaveBeenCalled();

		// IndexedDB is readable again (a fresh tab out of private browsing, a
		// transient quota/lock error clearing) and there IS a queue there.
		READ_FAILS = false;
		QUEUED = [OP()];
		await act(async () => {
			await result.current.retryDrain();
		});

		expect(result.current.syncError).toBeNull();
		// The re-read happened, and the queue it found drained. Both halves matter:
		// the queue appearing proves the load re-ran, `removeOp` proves the auto-drain
		// then picked it up rather than leaving it visible but stuck.
		await waitFor(
			() => expect(removeOpSpy).toHaveBeenCalledWith("meet-1", "op-1"),
			WAIT_OPTS,
		);
		await waitFor(
			() => expect(result.current.queue).toHaveLength(0),
			WAIT_OPTS,
		);
	});

	it("replays the queue when Retry follows a stalled drain (F6, non-empty arm)", async () => {
		// `retryDrain`'s other arm — the one Retry exists for. It could be replaced
		// with `return;` today and the suite stayed green, because the only test that
		// called `retryDrain` called it with an EMPTY queue.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			QUEUED = [OP()];
			openDispatchGate(); // never resolved: the replay hangs like a portal
			const { result } = renderHook(() =>
				useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
			);

			await tickUntil(() => result.current.syncError !== null);
			expect(result.current.syncError).toBe("No response from the network.");
			expect(result.current.queue).toHaveLength(1);
			expect(removeOpSpy).not.toHaveBeenCalled();

			// Wifi is genuinely back: the next dispatch answers.
			dispatchGate = null;
			// Started, not awaited: `removeOp` is genuinely async (a real 0ms timer),
			// and awaiting a chain that contains a timer while the clock is FROZEN
			// deadlocks the test — which then leaves fake timers installed and every
			// later test in the file renders `null`. Advance, then settle.
			let retrying!: Promise<void>;
			await act(async () => {
				retrying = result.current.retryDrain();
			});
			await tickUntil(() => result.current.queue.length === 0);
			await act(async () => {
				await retrying;
			});

			expect(removeOpSpy).toHaveBeenCalledWith("meet-1", "op-1");
			expect(result.current.queue).toHaveLength(0);
			expect(result.current.syncError).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT let a queued op overwrite a newer write that already SAVED (G1)", async () => {
		// The invariant: while the queue is non-empty the queue is the ONLY channel.
		//
		// Without it there are two, because the online-SUCCESS path never enqueues
		// and `mutate` never consulted `queue.length`. The queue's order then stops
		// matching wall-clock order and the last op to reach the server wins — the
		// OLDER one. `meeting_attendance` is what the minutes PDF and the emailed
		// minutes print from, so that is a wrong club record, not a display glitch.
		//
		// Steps 1-5 of the report, in order, with no race anywhere: the panel is
		// FULLY ENABLED in the parked state (`busy` and `draining` both false while
		// the drain sits on `syncError`) and the drain un-parks on a wifi blip with
		// no user action at all.
		//
		// Both channels funnel through the SAME mocked `setAttendance`, so
		// `setAttendanceSpy.mock.calls` is one ordered log of what the server was
		// told. Folding it last-write-wins is the server: `setAttendance` is an
		// `onConflictDoUpdate`. Asserting the FOLD rather than a call count is the
		// point — the bug and the fix issue the same writes, in a different order.
		vi.useFakeTimers();
		try {
			const { setAttendance } = await import("#/server/minutes");
			ONLINE = true;
			// STEP 1. Jane's `Present` blew its deadline on dead venue wifi and is
			// queued (seeded here as the persisted queue that state leaves behind).
			QUEUED = [OP()];
			openDispatchGate(); // the replay hangs like a captive portal
			const onMutated = vi.fn(async () => {});
			const { result, rerender } = renderHook(() =>
				useOfflineMinutes({ meetingId: "meet-1", onMutated }),
			);

			// STEP 2 + 3. The auto-drain's own dispatch deadline blows, `syncError`
			// parks the drain (`!syncError` gates the effect), and `finally` clears
			// `draining`. Every chip on the panel is live over a non-empty queue —
			// the route wires only `busy || draining` into `locked`.
			await tickUntil(() => result.current.syncError !== null);
			expect(result.current.syncError).toBe("No response from the network.");
			expect(result.current.queue).toHaveLength(1);
			expect(result.current.draining).toBe(false);
			expect(result.current.busy).toBe(false);

			// STEP 4. Jane is not in the room after all. The officer taps `Absent`,
			// and the wifi is briefly fine — so an unguarded online write would
			// SUCCEED here and never touch the queue.
			dispatchGate = null;
			const absentOp = () => ({
				type: "setAttendance" as const,
				opId: "op-absent",
				queuedAt: 2,
				memberId: "m1",
				status: "absent" as const,
			});
			await act(async () => {
				await result.current.mutate(
					() =>
						setAttendance({
							data: {
								meetingId: "meet-1",
								memberId: "m1",
								status: "absent",
							},
						}),
					absentOp,
				);
			});

			// The newer tap went to the QUEUE, behind the older op, so their relative
			// order is preserved by APPENDING. No second channel opened: the only
			// `setAttendance` the server has seen is the drain's hung replay.
			expect(result.current.queue.map((o) => o.opId)).toEqual([
				"op-1",
				"op-absent",
			]);
			expect(enqueueSpy).toHaveBeenCalledWith("meet-1", absentOp());
			expect(setAttendanceSpy).toHaveBeenCalledTimes(1);
			// …and the chip moved anyway, because `projectMinutes` replays a non-empty
			// queue regardless of `online`. This is the half F2 used to HIDE: with the
			// newer tap missing from the queue the projection reads back the STALE
			// `present` the instant `absent` is saved, so the officer re-taps and every
			// re-tap is another real server write displaying as the old status.
			expect(statusOnChip(result.current.queue, true)).toBe("absent");

			// STEP 5. One wifi blip, no user action: `if (!online) setSyncError(null)`
			// clears the parked error and the auto-drain re-fires on reconnect.
			await act(async () => {
				ONLINE = false;
				rerender();
			});
			expect(result.current.syncError).toBeNull();
			// Still `absent` while offline, where the projection reads the persisted
			// snapshot rather than the loader — the second sample of "never displays
			// the first", taken in the window the drain is about to run in.
			expect(statusOnChip(result.current.queue, false)).toBe("absent");
			await act(async () => {
				ONLINE = true;
				rerender();
			});
			await tickUntil(() => result.current.queue.length === 0);

			// The server's final status is the SECOND write. Under the bug the replay
			// of `present` lands AFTER the online `absent` and this fold reads
			// "present" — Jane is recorded in the club's minutes as having attended a
			// meeting she was not at.
			expect(lastServerStatusFor("m1")).toBe("absent");
			expect(result.current.queue).toHaveLength(0);
			expect(result.current.syncError).toBeNull();
			// Past this point the chip reads the loader refetch, not the queue (an
			// empty queue means `projectMinutes` returns the base untouched), so what
			// the officer sees IS `lastServerStatusFor` above — asserting
			// `statusOnChip` here would only re-read this test's own fixture.
			expect(onMutated).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT toast the deadline against a page the officer has already left (F7)", async () => {
		// The deadline's toast lands ONLINE_WRITE_TIMEOUT_MS after the tap. Unguarded,
		// "No response from the network — saved on this device" appeared on whatever
		// the officer navigated to, eight seconds later, about a meeting they left.
		// The `enqueue` is the opposite: it must happen either way, or the tap is lost.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			const hang = vi.fn(() => new Promise<unknown>(() => {}));
			const { result, unmount } = renderHook(() =>
				useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
			);
			await tickUntil(() => true);

			let pending!: Promise<void>;
			await act(async () => {
				pending = result.current.mutate(hang, OP);
			});
			expect(hang).toHaveBeenCalledTimes(1);

			unmount();
			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});

			// The tap survived...
			expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
			// ...silently.
			expect(toastErrorSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT toast the deadline against another MEETING the officer hopped to (F5)", async () => {
		// `mountedRef` alone cannot see this, and the mechanism that defeats it is
		// this hook's own reason for existing: the meeting route is NOT remounted
		// when the meeting param changes, so a tap on the nav strip leaves
		// `mountedRef.current === true`. Meeting A's deadline toast — "saved on this
		// device and will sync later" — therefore landed on meeting B, whose own
		// `SyncStatus` shows nothing because B's queue is empty. B read fully synced
		// while A's op sat stranded with no indicator anywhere.
		//
		// A `rerender` with a new id, NOT an unmount: an unmount is the F7 test above
		// and passes with or without this gate.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			const hang = vi.fn(() => new Promise<unknown>(() => {}));
			const { result, rerender } = renderHook(
				({ id }: { id: string }) =>
					useOfflineMinutes({ meetingId: id, onMutated: async () => {} }),
				{ initialProps: { id: "meet-1" } },
			);
			await tickUntil(() => true);

			let pending!: Promise<void>;
			await act(async () => {
				pending = result.current.mutate(hang, OP);
			});
			expect(hang).toHaveBeenCalledTimes(1);

			rerender({ id: "meet-2" });

			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});

			// The tap survived, under ITS OWN meeting — that half must not change.
			expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
			// And meeting B's page said nothing about it.
			expect(toastErrorSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("toasts the deadline while the officer is still on the page (F7 control)", async () => {
		// The other side of the assertion above, and the reason it cannot pass
		// vacuously: a hook that never toasted at all would satisfy the unmount test.
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
			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});

			expect(toastErrorSpy).toHaveBeenCalledWith(
				"No response from the network — saved on this device and will sync later.",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists the online snapshot for this meeting on every online render", async () => {
		// The snapshot-freshness effect. No test ever passed `minutes:`, and
		// `saveSnapshot` was a bare no-op mock, so the effect could have been deleted
		// whole: it is what the panel's OFFLINE projection falls back to, and the
		// hook's own comment calls omitting it "a silent regression across multiple
		// offline excursions in one un-reloaded session".
		ONLINE = true;
		// Rendered for its EFFECTS: the assertion is on what reached the store, so
		// there is no `result` to read (and TS's no-unused-locals would fail on one).
		renderHook(() =>
			useOfflineMinutes({
				meetingId: "meet-1",
				onMutated: async () => {},
				minutes: MINUTES_A,
			}),
		);

		// The DURABLE half is the observable, and asserted WITH the meeting id — the
		// same closure-vs-key hazard F1 is about, one IndexedDB key per meeting.
		// Not `result.current.snapshot`: the mount-time persisted load resolves after
		// this effect and overwrites that state with whatever was saved (null here),
		// which is pre-existing behaviour and harmless only because the panel derives
		// from `snapshot ?? minutes`.
		await waitFor(
			() => expect(saveSnapshotSpy).toHaveBeenCalledWith("meet-1", MINUTES_A),
			WAIT_OPTS,
		);
	});

	it("does NOT persist a snapshot while offline", async () => {
		// Offline the loader data is stale by definition — the panel is rendering its
		// own optimistic projection — so saving it would overwrite the last known
		// GOOD base with a copy of itself plus nothing.
		ONLINE = false;
		// Rendered for its EFFECTS: the assertion is on what reached the store, so
		// there is no `result` to read (and TS's no-unused-locals would fail on one).
		renderHook(() =>
			useOfflineMinutes({
				meetingId: "meet-1",
				onMutated: async () => {},
				minutes: MINUTES_A,
			}),
		);
		// Waits for the mount load to have RUN, so the assertion below lands after the
		// effects have had their chance rather than before them.
		await waitFor(() => expect(READ_COUNT).toBeGreaterThan(0), WAIT_OPTS);
		expect(saveSnapshotSpy).not.toHaveBeenCalled();
	});

	it("refuses a second write while the first is still in flight (busy arm)", async () => {
		// `mutate`'s guard is `if (busy || draining) return;` and only the `draining`
		// half was covered. The `busy` half is the one that fires during a normal roll
		// call on club wifi: two taps in the second it takes one write to land.
		vi.useFakeTimers();
		try {
			ONLINE = true;
			const hang = vi.fn(() => new Promise<unknown>(() => {}));
			const second = vi.fn(async () => {});
			const { result } = renderHook(() =>
				useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
			);
			await tickUntil(() => true);

			let pending!: Promise<void>;
			await act(async () => {
				pending = result.current.mutate(hang, OP);
			});
			expect(result.current.busy).toBe(true);

			await act(async () => {
				await result.current.mutate(second, OP2);
			});
			// Refused outright: not sent, and not queued either.
			expect(second).not.toHaveBeenCalled();
			expect(enqueueSpy).not.toHaveBeenCalledWith("meet-1", OP2());

			await tickUntil(() => enqueueSpy.mock.calls.length > 0);
			await act(async () => {
				await pending;
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("toasts a failed enqueue and KEEPS the optimistic row", async () => {
		// A rejecting `enqueue` (quota exceeded, a locked store) had no coverage, and
		// the roll-back question it raises has two defensible answers. This one keeps
		// the row: the op is still in the in-memory queue, so the auto-drain WILL
		// replay it this session — removing it would discard a write that is going to
		// be attempted, and would snap a chip the officer just tapped back to its old
		// value. What is genuinely lost is durability across a reload, and the toast
		// is what says so. Revisit only with a durable fallback to offer instead.
		ONLINE = false;
		ENQUEUE_FAILS = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		await act(async () => {
			await result.current.mutate(async () => {}, OP);
		});

		expect(toastErrorSpy).toHaveBeenCalledWith("IDB write blocked");
		expect(result.current.queue).toHaveLength(1);
	});

	it("keeps its deadline shorter than the wait it replaced", () => {
		// A sanity tie between the hook and the constant it imports: if this ever
		// reads Infinity/NaN the two tests above would hang or pass vacuously.
		expect(Number.isFinite(ONLINE_WRITE_TIMEOUT_MS)).toBe(true);
		expect(ONLINE_WRITE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});
