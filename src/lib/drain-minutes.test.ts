import { describe, expect, it, vi } from "vitest";
import {
	dispatchOp,
	drainMinutesQueue,
	type MinutesServerFns,
} from "./drain-minutes";
import type { MinutesOp } from "./offline-minutes-queue";

let seq = 0;
/** A generated op id + timestamp; the drain only uses opId, order-preserving. */
function meta() {
	seq += 1;
	return { opId: `op-${seq}`, queuedAt: 1000 + seq };
}

/** A `MinutesServerFns` where every fn is a spy resolving to `{ ok: true }`. */
function fakeFns(): MinutesServerFns {
	return {
		setAttendance: vi.fn().mockResolvedValue({ ok: true }),
		addGuest: vi.fn().mockResolvedValue({ ok: true }),
		removeGuest: vi.fn().mockResolvedValue({ ok: true }),
		addTableTopics: vi.fn().mockResolvedValue({ ok: true }),
		removeTableTopics: vi.fn().mockResolvedValue({ ok: true }),
		moveTableTopics: vi.fn().mockResolvedValue({ ok: true }),
		setAward: vi.fn().mockResolvedValue({ ok: true }),
		clearAward: vi.fn().mockResolvedValue({ ok: true }),
	};
}

const MEETING = "meeting-1";

describe("dispatchOp", () => {
	it("maps setAttendance to setAttendance with member + status", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "setAttendance",
			...meta(),
			memberId: "m-alice",
			status: "present",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.setAttendance).toHaveBeenCalledWith({
			data: { meetingId: MEETING, memberId: "m-alice", status: "present" },
		});
	});

	it("forwards releaseHeldRoles only when the op carries it, and returns what the server freed", async () => {
		// protects=#1256: a queued Absent+release replays WITH the flag and the labels
		//   the server reports come back for the drain toast; a plain Absent replays
		//   without the key and returns nothing
		// fails_when=the flag is dropped on replay (roles never freed), sent as `false`
		//   on a plain op (a stale-schema refusal), or the server's labels are lost
		// no_claim=that the real server frees the roles (absent-release integration)
		const fns = fakeFns();
		(fns.setAttendance as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			released: [{ label: "Speaker 2" }, { label: "Timer" }],
		});
		const releasing: MinutesOp = {
			type: "setAttendance",
			...meta(),
			memberId: "m-alice",
			status: "absent",
			releaseHeldRoles: true,
			releaseSlotIds: ["slot-a", "slot-b"],
		};
		const outcome = await dispatchOp(releasing, MEETING, fns);
		expect(fns.setAttendance).toHaveBeenLastCalledWith({
			data: {
				meetingId: MEETING,
				memberId: "m-alice",
				status: "absent",
				releaseHeldRoles: true,
				releaseSlotIds: ["slot-a", "slot-b"],
			},
		});
		expect(outcome).toEqual({
			released: { memberId: "m-alice", labels: ["Speaker 2", "Timer"] },
		});

		const plain: MinutesOp = {
			type: "setAttendance",
			...meta(),
			memberId: "m-alice",
			status: "absent",
		};
		expect(await dispatchOp(plain, MEETING, fns)).toBeUndefined();
		const call = (fns.setAttendance as ReturnType<typeof vi.fn>).mock.calls.at(
			-1,
		)?.[0];
		expect(call.data).not.toHaveProperty("releaseHeldRoles");
		expect(call.data).not.toHaveProperty("releaseSlotIds");
	});

	it("never sends a bare releaseHeldRoles: an op without ids replays as a plain Absent", async () => {
		// protects=H1: the replay's ceiling is the confirmed ids, so a flag with none
		//   (or an empty list) must not reach the server, whose schema would refuse
		//   it and whose meaning would be "free everything held"
		// fails_when=`releaseHeldRoles` is forwarded on the flag alone
		// no_claim=none beyond protects
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "setAttendance",
			...meta(),
			memberId: "m-alice",
			status: "absent",
			releaseHeldRoles: true,
		};
		expect(await dispatchOp(op, MEETING, fns)).toBeUndefined();
		const call = (fns.setAttendance as ReturnType<typeof vi.fn>).mock.calls.at(
			-1,
		)?.[0];
		expect(call.data).not.toHaveProperty("releaseHeldRoles");
		expect(call.data).not.toHaveProperty("releaseSlotIds");
	});

	it("a replayed release that finds nothing to free reports an empty label list", async () => {
		// protects=a slot reassigned before the drain is not freed, so the server
		//   returns an empty list and the outcome carries no labels (the drain then
		//   shows no toast)
		// fails_when=a missing/empty `released` throws or is reported as freed
		// no_claim=none beyond protects
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "setAttendance",
			...meta(),
			memberId: "m-alice",
			status: "absent",
			releaseHeldRoles: true,
			releaseSlotIds: ["slot-a"],
		};
		expect(await dispatchOp(op, MEETING, fns)).toEqual({
			released: { memberId: "m-alice", labels: [] },
		});
	});

	it("maps a NEW-guest addGuest and threads id: op.guestId (idempotency)", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "addGuest",
			...meta(),
			guestId: "g-new",
			name: "Aaron",
			newGuest: { name: "Aaron", email: "a@x.io" },
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.addGuest).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING,
				id: "g-new",
				newGuest: { name: "Aaron", email: "a@x.io" },
			},
		});
		// The new-guest path must NOT send guestId (it sends id instead).
		const call = (fns.addGuest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.data).not.toHaveProperty("guestId");
	});

	it("maps an EXISTING-guest addGuest to guestId (no id)", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "addGuest",
			...meta(),
			guestId: "g-existing",
			name: "Zed",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.addGuest).toHaveBeenCalledWith({
			data: { meetingId: MEETING, guestId: "g-existing" },
		});
		const call = (fns.addGuest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.data).not.toHaveProperty("id");
	});

	it("maps removeGuest to removeGuest with guestId", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "removeGuest",
			...meta(),
			guestId: "g-new",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.removeGuest).toHaveBeenCalledWith({
			data: { meetingId: MEETING, guestId: "g-new" },
		});
	});

	it("maps addTableTopics and threads id: op.id (speaker-row identity)", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "addTableTopics",
			...meta(),
			id: "tt-new",
			name: "Bob",
			isGuest: false,
			memberId: "m-bob",
			topic: "Improv",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.addTableTopics).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING,
				id: "tt-new",
				memberId: "m-bob",
				guestId: undefined,
				newGuest: undefined,
				topic: "Improv",
			},
		});
	});

	it("maps a new-guest addTableTopics (newGuest, no memberId)", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "addTableTopics",
			...meta(),
			id: "tt-guest",
			name: "Newbie",
			isGuest: true,
			newGuest: { name: "Newbie" },
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.addTableTopics).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING,
				id: "tt-guest",
				memberId: undefined,
				guestId: undefined,
				newGuest: { name: "Newbie" },
				topic: undefined,
			},
		});
	});

	it("forwards newGuestId on a new-guest addTableTopics (idempotent replay, #176 slice 5)", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "addTableTopics",
			...meta(),
			id: "tt-guest",
			name: "Newbie",
			isGuest: true,
			newGuest: { name: "Newbie" },
			newGuestId: "guest-pk",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.addTableTopics).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING,
				id: "tt-guest",
				memberId: undefined,
				guestId: undefined,
				newGuest: { name: "Newbie" },
				newGuestId: "guest-pk",
				topic: undefined,
			},
		});
	});

	it("maps removeTableTopics to removeTableTopics with id", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "removeTableTopics",
			...meta(),
			id: "tt-1",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.removeTableTopics).toHaveBeenCalledWith({
			data: { meetingId: MEETING, id: "tt-1" },
		});
	});

	it("maps moveTableTopics to moveTableTopics with id + direction", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-1",
			direction: "down",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.moveTableTopics).toHaveBeenCalledWith({
			data: { meetingId: MEETING, id: "tt-1", direction: "down" },
		});
	});

	it("forwards moveTableTopics' ABSOLUTE toIndex, which is what makes a replay safe (G2)", async () => {
		// `moveTableTopics` is the one op that does not converge on `direction` alone:
		// a relative swap replayed steps the row a SECOND position, silently
		// corrupting the Table Topics speaking order in the saved minutes. The
		// absolute target has to reach the server or the whole fix is inert here —
		// dropping it from this payload is a change no other assertion in this file
		// can see, since `direction` is still sent and still type-checks.
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-1",
			direction: "down",
			toIndex: 2,
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.moveTableTopics).toHaveBeenCalledWith({
			data: { meetingId: MEETING, id: "tt-1", direction: "down", toIndex: 2 },
		});
	});

	it("maps setAward to setAward with category + winner", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "setAward",
			...meta(),
			category: "best_speaker",
			name: "Alice",
			isGuest: false,
			memberId: "m-alice",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.setAward).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING,
				category: "best_speaker",
				memberId: "m-alice",
				guestId: undefined,
				newGuest: undefined,
			},
		});
	});

	it("forwards newGuestId on a new-guest setAward (idempotent replay, #176 slice 5)", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "setAward",
			...meta(),
			category: "best_table_topics",
			name: "Guesty",
			isGuest: true,
			newGuest: { name: "Guesty" },
			newGuestId: "guest-pk",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.setAward).toHaveBeenCalledWith({
			data: {
				meetingId: MEETING,
				category: "best_table_topics",
				memberId: undefined,
				guestId: undefined,
				newGuest: { name: "Guesty" },
				newGuestId: "guest-pk",
			},
		});
	});

	it("maps clearAward to clearAward with category", async () => {
		const fns = fakeFns();
		const op: MinutesOp = {
			type: "clearAward",
			...meta(),
			category: "best_evaluator",
		};
		await dispatchOp(op, MEETING, fns);
		expect(fns.clearAward).toHaveBeenCalledWith({
			data: { meetingId: MEETING, category: "best_evaluator" },
		});
	});

	it("calls exactly one fn per dispatch", async () => {
		const fns = fakeFns();
		await dispatchOp(
			{ type: "clearAward", ...meta(), category: "best_speaker" },
			MEETING,
			fns,
		);
		expect(fns.clearAward).toHaveBeenCalledTimes(1);
		expect(fns.setAward).not.toHaveBeenCalled();
		expect(fns.setAttendance).not.toHaveBeenCalled();
	});
});

describe("drainMinutesQueue", () => {
	/** A fake durable queue backed by an in-memory list of remaining opIds. */
	function fakeQueue(ops: MinutesOp[]) {
		const removed: string[] = [];
		return {
			removed,
			onOpDrained: async (opId: string) => {
				removed.push(opId);
			},
			get remainingIds() {
				return ops.map((o) => o.opId).filter((id) => !removed.includes(id));
			},
		};
	}

	it("is a no-op for an empty queue", async () => {
		const dispatch = vi.fn().mockResolvedValue(undefined);
		const onOpDrained = vi.fn().mockResolvedValue(undefined);
		const result = await drainMinutesQueue({
			meetingId: MEETING,
			ops: [],
			dispatch,
			onOpDrained,
		});
		expect(result).toEqual({
			drainedCount: 0,
			remaining: [],
			error: undefined,
			released: [],
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(onOpDrained).not.toHaveBeenCalled();
	});

	it("drains every op in order and removes each one", async () => {
		const ops: MinutesOp[] = [
			{ type: "setAttendance", ...meta(), memberId: "m-a", status: "present" },
			{ type: "addGuest", ...meta(), guestId: "g-1", name: "Guest" },
			{ type: "removeTableTopics", ...meta(), id: "tt-1" },
		];
		const seen: string[] = [];
		const dispatch = vi.fn(async (op: MinutesOp) => {
			seen.push(op.opId);
			return undefined;
		});
		const q = fakeQueue(ops);

		const result = await drainMinutesQueue({
			meetingId: MEETING,
			ops,
			dispatch,
			onOpDrained: q.onOpDrained,
		});

		// Sequential order preserved.
		expect(seen).toEqual(ops.map((o) => o.opId));
		// Each op removed from the queue exactly once, in order.
		expect(q.removed).toEqual(ops.map((o) => o.opId));
		expect(q.remainingIds).toEqual([]);
		expect(result).toEqual({
			drainedCount: 3,
			remaining: [],
			error: undefined,
			released: [],
		});
	});

	it("stops at the first failure and keeps the failed op + successors", async () => {
		const ops: MinutesOp[] = [
			{ type: "setAttendance", ...meta(), memberId: "m-a", status: "present" },
			{ type: "removeTableTopics", ...meta(), id: "tt-boom" },
			{ type: "clearAward", ...meta(), category: "best_speaker" },
		];
		const boom = new Error("network down");
		const dispatch = vi.fn(async (op: MinutesOp) => {
			if (op.opId === ops[1].opId) throw boom;
			return undefined;
		});
		const q = fakeQueue(ops);

		const result = await drainMinutesQueue({
			meetingId: MEETING,
			ops,
			dispatch,
			onOpDrained: q.onOpDrained,
		});

		// Only the first op drained; dispatch stopped at the failing op (not the 3rd).
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(result.drainedCount).toBe(1);
		expect(result.error).toBe(boom);
		// The failed op AND its successors remain, in order.
		expect(result.remaining).toEqual([ops[1], ops[2]]);
		// onOpDrained was called ONLY for the first (successful) op.
		expect(q.removed).toEqual([ops[0].opId]);
		expect(q.remainingIds).toEqual([ops[1].opId, ops[2].opId]);
	});

	it("resumes from the failed op on a second drain of the remaining ops", async () => {
		const ops: MinutesOp[] = [
			{ type: "setAttendance", ...meta(), memberId: "m-a", status: "present" },
			{ type: "removeTableTopics", ...meta(), id: "tt-x" },
		];
		let failFirstOnce = true;
		const dispatch = vi.fn(async (op: MinutesOp) => {
			if (op.opId === ops[1].opId && failFirstOnce) {
				failFirstOnce = false;
				throw new Error("transient");
			}
			return undefined;
		});
		const q = fakeQueue(ops);

		const first = await drainMinutesQueue({
			meetingId: MEETING,
			ops,
			dispatch,
			onOpDrained: q.onOpDrained,
		});
		expect(first.drainedCount).toBe(1);
		expect(first.remaining).toEqual([ops[1]]);

		// Reconnect: drain what remains — now it succeeds.
		const second = await drainMinutesQueue({
			meetingId: MEETING,
			ops: first.remaining,
			dispatch,
			onOpDrained: q.onOpDrained,
		});
		expect(second).toEqual({
			drainedCount: 1,
			remaining: [],
			error: undefined,
			released: [],
		});
		expect(q.removed).toEqual([ops[0].opId, ops[1].opId]);
		expect(q.remainingIds).toEqual([]);
	});

	it("DrainResult.released lists the ops that freed something, in order, and keeps them when a later op fails", async () => {
		// protects=#1256: one entry per drained Absent op that freed roles, empty
		//   outcomes dropped, and the entries of ops drained BEFORE a failure survive
		//   it (their release happened)
		// fails_when=`released` is built only on full success, includes an empty
		//   release, or is lost when the stop-on-failure return runs
		// no_claim=the toast and invalidate that consume it (use-offline-minutes test)
		const ops: MinutesOp[] = [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-a",
				status: "absent",
				releaseHeldRoles: true,
				releaseSlotIds: ["s1"],
			},
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-b",
				status: "absent",
				releaseHeldRoles: true,
				releaseSlotIds: ["s2"],
			},
			{ type: "removeTableTopics", ...meta(), id: "tt-x" },
		];
		const outcomes = [
			{ released: { memberId: "m-a", labels: ["Timer"] } },
			{ released: { memberId: "m-b", labels: [] } },
		];
		let i = 0;
		const dispatch = vi.fn(async (op: MinutesOp) => {
			if (op.type === "removeTableTopics") throw new Error("down");
			return outcomes[i++];
		});
		const q = fakeQueue(ops);

		const result = await drainMinutesQueue({
			meetingId: MEETING,
			ops,
			dispatch,
			onOpDrained: q.onOpDrained,
		});

		expect(result.drainedCount).toBe(2);
		expect(result.remaining).toEqual([ops[2]]);
		expect(result.released).toEqual([{ memberId: "m-a", labels: ["Timer"] }]);
	});
	it("a queue-removal failure is the drain's error, and the receipts collected so far survive it (L1)", async () => {
		// protects=the IndexedDB removal throwing after a release landed returns
		//   { error, released } instead of rejecting, so the hook still toasts what
		//   was freed and refreshes the agenda; the op stays in `remaining`
		// fails_when=the removal is not caught (drainMinutesQueue rejects and
		//   `released` is lost), or `released` is dropped from that return
		// no_claim=the toast and refresh themselves (use-offline-minutes.test.ts)
		const ops: MinutesOp[] = [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-a",
				status: "absent",
				releaseHeldRoles: true,
				releaseSlotIds: ["s1"],
			},
		];
		const boom = new Error("IndexedDB is gone");

		const result = await drainMinutesQueue({
			meetingId: MEETING,
			ops,
			dispatch: async () => ({
				released: { memberId: "m-a", labels: ["Timer"] },
			}),
			onOpDrained: async () => {
				throw boom;
			},
		});

		expect(result.error).toBe(boom);
		expect(result.released).toEqual([{ memberId: "m-a", labels: ["Timer"] }]);
		expect(result.drainedCount).toBe(0);
		expect(result.remaining).toEqual(ops);
	});
});
