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
		});
		expect(q.removed).toEqual([ops[0].opId, ops[1].opId]);
		expect(q.remainingIds).toEqual([]);
	});
});
