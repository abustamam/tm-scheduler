// @vitest-environment jsdom
/**
 * The role-op half of `useOfflineMinutes` (#1638): the minutes / role split,
 * the stamp of who queued a role op, the lazy role-fns import, the skip toast,
 * the deck message after the removal commits, the held replay for another
 * member (R2) and the cross-tab drain lock (R3). The minutes half has its own
 * suite (use-offline-minutes.test.ts), which this one does not touch.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleSkipMessage } from "#/lib/drain-minutes";
import type { QueuedOp, RoleSlotOp } from "#/lib/offline-minutes-queue";
import { SIGN_IN_TO_QUEUE_ROLE_MESSAGE } from "#/lib/role-op-owner";
import { useOfflineMinutes } from "./use-offline-minutes";

const h = vi.hoisted(() => ({
	store: [] as unknown[],
	events: [] as string[],
	roleFnsLoaded: false,
	online: true,
	claimSlot: vi.fn(),
	reassignSlot: vi.fn(),
	releaseSlot: vi.fn(),
	setAttendance: vi.fn(),
	toastWarning: vi.fn(),
	toastError: vi.fn(),
	postDrained: vi.fn(),
	postChanged: vi.fn(),
}));

vi.mock("#/lib/offline-minutes-queue", () => ({
	enqueue: async (_m: string, op: unknown) => {
		h.events.push("enqueue");
		h.store.push(op);
	},
	readQueue: async () => [...h.store],
	readSnapshot: async () => null,
	saveSnapshot: async () => {},
	removeOp: async (_m: string, opId: string) => {
		await new Promise((r) => setTimeout(r, 0));
		h.events.push(`remove:${opId}`);
		h.store = h.store.filter((o) => (o as { opId: string }).opId !== opId);
	},
}));
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => h.online,
	useOfflineReady: () => true,
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => h.toastError(...a),
		success: vi.fn(),
		warning: (...a: unknown[]) => h.toastWarning(...a),
		message: vi.fn(),
	},
}));
vi.mock("#/lib/agenda-live", () => ({
	postAgendaChanged: () => {
		h.events.push("postChanged");
		h.postChanged();
	},
}));
vi.mock("#/lib/drained-roles", () => ({
	postRoleOpsDrained: (d: unknown) => {
		h.events.push("postDrained");
		h.postDrained(d);
	},
}));
vi.mock("#/server/minutes", () => ({
	setAttendance: (...a: unknown[]) => h.setAttendance(...a),
	addMinutesGuest: vi.fn(),
	removeMinutesGuest: vi.fn(),
	addTableTopics: vi.fn(),
	removeTableTopics: vi.fn(),
	moveTableTopics: vi.fn(),
	setMinutesAward: vi.fn(),
	clearMinutesAward: vi.fn(),
}));
vi.mock("#/lib/role-server-fns", () => {
	h.roleFnsLoaded = true;
	return {
		claimSlot: (...a: unknown[]) => h.claimSlot(...a),
		reassignSlot: (...a: unknown[]) => h.reassignSlot(...a),
		releaseSlot: (...a: unknown[]) => h.releaseSlot(...a),
	};
});

const assign = (over: Partial<RoleSlotOp> = {}): RoleSlotOp =>
	({
		type: "assignSlot",
		opId: "a1",
		queuedAt: 1,
		slotId: "s1",
		roleName: "Timer",
		memberId: "bob",
		memberDisplayName: "Bob",
		actorMemberId: "adm",
		expectedHolder: null,
		expectedHolderName: null,
		queuedBy: "adm",
		...over,
	}) as RoleSlotOp;
const release = (over: Partial<RoleSlotOp> = {}): RoleSlotOp =>
	({
		type: "releaseSlot",
		opId: "r1",
		queuedAt: 2,
		slotId: "s1",
		roleName: "Timer",
		expectedHolder: "m:bob",
		expectedHolderName: "Bob",
		queuedBy: "adm",
		...over,
	}) as RoleSlotOp;
const attendance = (): QueuedOp => ({
	type: "setAttendance",
	opId: "t1",
	queuedAt: 3,
	memberId: "ann",
	status: "present",
});

function mount(sessionMemberId: string | null = "adm") {
	return renderHook(() =>
		useOfflineMinutes({
			meetingId: "m1",
			onMutated: async () => {},
			sessionMemberId,
		}),
	);
}

beforeEach(() => {
	h.store = [];
	h.events = [];
	h.online = true;
	h.claimSlot.mockReset().mockResolvedValue({ ok: true });
	h.reassignSlot.mockReset().mockResolvedValue({ ok: true });
	h.releaseSlot.mockReset().mockResolvedValue({ ok: true });
	h.setAttendance.mockReset().mockResolvedValue(undefined);
	h.toastWarning.mockReset();
	h.toastError.mockReset();
	h.postDrained.mockReset();
	h.postChanged.mockReset();
});
afterEach(() => {
	cleanup();
	Reflect.deleteProperty(navigator, "locks");
});

describe("useOfflineMinutes with role ops (#1638)", () => {
	// protects=a drain of MINUTES ops alone never loads the slot writers (they
	//   pull the server module into a path that has no use for it);
	// fails_when=the role-fns import becomes unconditional;
	// no_claim=a role drain (below). Runs FIRST: the module's load is cached for
	//   the file, so a later test could already have loaded it.
	it("a minutes-only drain does not import the role fns", async () => {
		h.store = [attendance()];
		mount();
		await waitFor(() => expect(h.setAttendance).toHaveBeenCalledTimes(1), {
			timeout: 5000,
		});
		expect(h.roleFnsLoaded).toBe(false);
	});

	// protects=`queue` stays minutes-only (every minutes consumer projects it),
	//   `roleOps` is the role half, `pendingCount` is both;
	// fails_when=a role op leaks into `queue`, or pendingCount counts one half;
	// no_claim=drain behaviour.
	it("splits the queue into minutes ops and role ops, and counts both", async () => {
		h.online = false;
		h.store = [attendance(), assign()];
		const { result } = mount();
		await waitFor(() => expect(result.current.pendingCount).toBe(2), {
			timeout: 5000,
		});
		expect(result.current.queue.map((o) => o.opId)).toEqual(["t1"]);
		expect(result.current.roleOps.map((o) => o.opId)).toEqual(["a1"]);
	});

	// protects=R2: the member signed in at enqueue is stamped on the role op, and
	//   the deck is told AFTER the write committed; a minutes op is not stamped;
	// fails_when=queuedBy is not stamped (or stamped from a stale render), the
	//   broadcast precedes the write, or a minutes op gains the field;
	// no_claim=the drain's check (drain-role-ops.test.ts).
	it("stamps who queued a role op and broadcasts after the enqueue", async () => {
		h.online = false;
		const { result } = mount("officer-a");
		await act(async () => {
			await result.current.mutate(
				async () => {},
				() => ({ ...assign({ queuedBy: undefined }) }),
			);
			await result.current.mutate(async () => {}, attendance);
		});
		expect((h.store[0] as RoleSlotOp).queuedBy).toBe("officer-a");
		expect("queuedBy" in (h.store[1] as object)).toBe(false);
		expect(h.events.slice(0, 2)).toEqual(["enqueue", "postChanged"]);
	});

	// protects=a caller that reports the refusal itself (the role writes) gets it
	//   back instead of a toast, and everyone else keeps the toast;
	// fails_when=throwOnError is ignored (a swallowed sign-in refusal) or applied
	//   to callers that did not ask;
	// no_claim=the deadline path.
	it("throwOnError rethrows an online refusal; without it the refusal toasts", async () => {
		const { result } = mount();
		await act(async () => {
			await expect(
				result.current.mutate(
					async () => {
						throw new Error("sign in");
					},
					() => assign(),
					{ throwOnError: true },
				),
			).rejects.toThrow("sign in");
		});
		expect(h.toastError).not.toHaveBeenCalled();
		await act(async () => {
			await result.current.mutate(
				async () => {
					throw new Error("boom");
				},
				() => assign(),
			);
		});
		expect(h.toastError).toHaveBeenCalledWith("boom");
	});

	// protects=a skipped role op leaves with its toast, and the deck hears about
	//   it only AFTER the removal committed, with how it ended;
	// fails_when=the warning is not shown, shows another text, or the message
	//   precedes the IndexedDB removal;
	// no_claim=the toast wording (drain-role-ops.test.ts).
	it("toasts a skipped op and tells the deck after the removal", async () => {
		const skip = {
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Zed",
			holderPresent: true,
		};
		h.claimSlot.mockResolvedValue(skip);
		h.store = [assign()];
		mount();
		await waitFor(() => expect(h.postDrained).toHaveBeenCalledTimes(1), {
			timeout: 5000,
		});
		expect(h.roleFnsLoaded).toBe(true);
		expect(h.toastWarning).toHaveBeenCalledWith(
			roleSkipMessage({
				op: assign(),
				outcome: "skipped",
				reason: "holder-changed",
				currentHolderName: "Zed",
				holderPresent: true,
			}),
		);
		expect(h.events.indexOf("remove:a1")).toBeLessThan(
			h.events.indexOf("postDrained"),
		);
		expect(h.postDrained.mock.calls[0]?.[0][0]).toMatchObject({
			outcome: "skipped",
			reason: "holder-changed",
			currentHolderName: "Zed",
		});
	});

	// protects=R2: op queued by officer A is held when member B is signed in:
	//   nothing is dispatched, the op stays queued, and it is reported as held
	//   (not as a sync error, which would park the auto-drain);
	// fails_when=the hook drains under whoever is signed in, passes no session
	//   to the dispatch, or reports the hold as a `syncError`;
	// no_claim=what B's attendance holds (no server call is made at all).
	it("R2: holds another member's role op and reports it as held", async () => {
		h.store = [assign({ queuedBy: "officer-a" })];
		const { result } = mount("member-b");
		await waitFor(() => expect(result.current.heldOps).toHaveLength(1), {
			timeout: 5000,
		});
		expect(h.claimSlot).not.toHaveBeenCalled();
		expect(h.store).toHaveLength(1);
		expect(result.current.syncError).toBeNull();
		expect(result.current.pendingCount).toBe(0);
	});

	// protects=a hold is not a sync error: attendance queued behind a held role
	//   op drains, the held op stays, and the drain is not re-run on it;
	// fails_when=the hold stops the drain (attendance never dispatched), reads as
	//   "all synced", or sets `syncError`;
	// no_claim=a held MINUTES op (unchanged stop-the-drain, in drain-role-ops).
	it("a held role op: later attendance drains and no sync error shows", async () => {
		h.store = [assign({ queuedBy: "officer-a" }), attendance()];
		const { result } = mount("member-b");
		await waitFor(() => expect(h.setAttendance).toHaveBeenCalledTimes(1), {
			timeout: 5000,
		});
		await waitFor(() => expect(result.current.heldOps).toHaveLength(1));
		expect(h.claimSlot).not.toHaveBeenCalled();
		expect(h.store.map((o) => (o as { opId: string }).opId)).toEqual(["a1"]);
		expect(result.current.syncError).toBeNull();
		expect(result.current.justSynced).toBe(false);
	});

	// protects=after a hold, a newly queued attendance op auto-drains with no
	//   Retry (the hold does not park the auto-drain);
	// fails_when=the hold sets `syncError` or the auto-drain gates on the queue
	//   holding only held ops, so the new op waits;
	// no_claim=the order of that op against the held one (different keys).
	it("after a hold, a newly queued attendance op auto-drains without Retry", async () => {
		h.store = [assign({ queuedBy: "officer-a" })];
		const { result, rerender } = mount("member-b");
		await waitFor(() => expect(result.current.heldOps).toHaveLength(1));
		h.online = false;
		rerender();
		await act(async () => {
			await result.current.mutate(
				async () => {},
				() => attendance(),
			);
		});
		expect(h.setAttendance).not.toHaveBeenCalled();
		h.online = true;
		rerender();
		await waitFor(() => expect(h.setAttendance).toHaveBeenCalledTimes(1), {
			timeout: 5000,
		});
		expect(result.current.syncError).toBeNull();
		expect(h.store.map((o) => (o as { opId: string }).opId)).toEqual(["a1"]);
	});

	// protects=an online write with only held ops in the queue goes straight to
	//   the server, not into the queue;
	// fails_when=`mutate` counts held ops toward "the queue is non-empty";
	// no_claim=a role write on a held slot (next test).
	it("an online write with only held ops queued goes direct", async () => {
		h.store = [assign({ queuedBy: "officer-a" })];
		const { result } = mount("member-b");
		await waitFor(() => expect(result.current.heldOps).toHaveLength(1));
		const direct = vi.fn(async () => {});
		await act(async () => {
			await result.current.mutate(direct, () => attendance());
		});
		expect(direct).toHaveBeenCalledTimes(1);
		expect(h.store).toHaveLength(1);
	});

	// protects=a ROLE write on a slot that has a held op queues behind it (the
	//   per-slot order holds); a role write on another slot still goes direct;
	// fails_when=the held-slot exception is dropped (the write lands first and
	//   the held op later replays over it);
	// no_claim=a minutes write on that slot (not a role op).
	it("a role write on a held slot queues; on another slot it goes direct", async () => {
		h.store = [assign({ queuedBy: "officer-a" })];
		const { result } = mount("member-b");
		await waitFor(() => expect(result.current.heldOps).toHaveLength(1));
		const direct = vi.fn(async () => {});
		await act(async () => {
			await result.current.mutate(direct, () =>
				release({ opId: "r9", slotId: "s1", queuedBy: undefined }),
			);
		});
		expect(direct).not.toHaveBeenCalled();
		expect(h.store.map((o) => (o as { opId: string }).opId)).toEqual([
			"a1",
			"r9",
		]);
		await act(async () => {
			await result.current.mutate(direct, () =>
				release({ opId: "r10", slotId: "s2", queuedBy: undefined }),
			);
		});
		expect(direct).toHaveBeenCalledTimes(1);
	});

	// protects=held ops are not re-dispatched in a loop: over a long window the
	//   drain runs once for them (counted at the cross-tab lock, which every
	//   drain takes);
	// fails_when=the auto-drain re-fires on a queue of held ops only;
	// no_claim=that a drain made for an identity change or Retry also runs once.
	it("does not re-dispatch held ops in a loop", async () => {
		vi.useFakeTimers();
		try {
			const request = vi.fn((_n: string, cb: () => Promise<unknown>) => cb());
			Object.defineProperty(navigator, "locks", {
				configurable: true,
				value: { request },
			});
			h.store = [assign({ queuedBy: "officer-a" })];
			const { result } = mount("member-b");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(30_000);
			});
			expect(result.current.heldOps).toHaveLength(1);
			expect(request).toHaveBeenCalledTimes(1);
			expect(h.claimSlot).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// protects=signing in as the owner makes the held ops eligible again and they
	//   drain;
	// fails_when=held ids are remembered across a session change;
	// no_claim=a second non-owner identity (it holds them again, once).
	it("signing in as the owner drains the held ops", async () => {
		h.store = [assign({ queuedBy: "officer-a" })];
		const { result, rerender } = renderHook(
			({ m }: { m: string }) =>
				useOfflineMinutes({
					meetingId: "m1",
					onMutated: async () => {},
					sessionMemberId: m,
				}),
			{ initialProps: { m: "member-b" } },
		);
		await waitFor(() => expect(result.current.heldOps).toHaveLength(1));
		expect(h.claimSlot).not.toHaveBeenCalled();
		rerender({ m: "officer-a" });
		await waitFor(() => expect(h.claimSlot).toHaveBeenCalledTimes(1), {
			timeout: 5000,
		});
		await waitFor(() => expect(h.store).toEqual([]));
		expect(result.current.heldOps).toHaveLength(0);
	});

	// protects=Discard removes ONLY the held role ops, leaves a minutes op, and
	//   tells the deck AFTER the removal (so the deck's re-read of the queue,
	//   which is what stops it projecting them, no longer finds them);
	// fails_when=Discard clears the whole queue, leaves a held op, or broadcasts
	//   before the removal;
	// no_claim=the confirm step (a SyncStatus concern).
	it("Discard removes only the held ops and broadcasts after", async () => {
		h.store = [
			assign({ queuedBy: "officer-a" }),
			release({ queuedBy: "officer-a" }),
		];
		const { result, rerender } = mount("member-b");
		await waitFor(() => expect(result.current.heldOps).toHaveLength(2));
		// A minutes op queued meanwhile, offline, and not drained yet.
		h.online = false;
		rerender();
		await act(async () => {
			await result.current.mutate(
				async () => {},
				() => attendance(),
			);
		});
		let seenByDeck: string[] = [];
		h.postChanged.mockImplementation(() => {
			seenByDeck = h.store.map((o) => (o as { opId: string }).opId);
		});
		await act(async () => {
			await result.current.discardHeld();
		});
		expect(seenByDeck).toEqual(["t1"]);
		expect(h.postChanged).toHaveBeenCalled();
		expect(h.store.map((o) => (o as { opId: string }).opId)).toEqual(["t1"]);
		expect(result.current.heldOps).toHaveLength(0);
		expect(result.current.queue).toHaveLength(1);
	});

	// protects=signed out, a clear or a reassign is refused at queue time with
	//   the sign-in message and nothing is stored; a claim of an open slot (it
	//   has its asserting actor) is not refused by this rule;
	// fails_when=the refusal is dropped (an ownerless clear is queued), or it
	//   also refuses the claim;
	// no_claim=the online path (nothing is queued there).
	it("signed out, a queued clear or reassign is refused", async () => {
		h.online = false;
		const { result } = mount(null);
		await act(async () => {
			await expect(
				result.current.mutate(
					async () => {},
					() => release(),
				),
			).rejects.toThrow(SIGN_IN_TO_QUEUE_ROLE_MESSAGE);
			await expect(
				result.current.mutate(
					async () => {},
					() => assign({ expectedHolder: "m:ann" }),
				),
			).rejects.toThrow(SIGN_IN_TO_QUEUE_ROLE_MESSAGE);
		});
		expect(h.store).toHaveLength(0);
		await act(async () => {
			await result.current.mutate(
				async () => {},
				() => assign(),
			);
		});
		expect(h.store).toHaveLength(1);
	});

	// protects=R3: two tabs draining one queue dispatch each op ONCE (a second
	//   replay of "assign X (expected open)" after "release (expected X)" would
	//   bring X back); the waiting tab re-reads the queue inside the lock;
	// fails_when=the drain is not wrapped in the lock, or does not re-read inside
	//   it (the second tab replays from its stale copy);
	// no_claim=real Web Locks (the stub serializes callbacks the same way) and
	//   the browsers without the API, which drain as before.
	it("R3: two tabs drain once: each op is dispatched a single time", async () => {
		let chain: Promise<unknown> = Promise.resolve();
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request: (_name: string, cb: () => Promise<unknown>) => {
					const run = chain.then(() => cb());
					chain = run.catch(() => {});
					return run;
				},
			},
		});
		h.store = [assign({ opId: "a1" }), release({ opId: "r1" })];
		mount();
		mount();
		await waitFor(() => expect(h.releaseSlot).toHaveBeenCalled(), {
			timeout: 5000,
		});
		// Let the second tab finish its (empty) pass.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		expect(h.claimSlot).toHaveBeenCalledTimes(1);
		expect(h.releaseSlot).toHaveBeenCalledTimes(1);
		expect(h.store).toEqual([]);
	});
});
