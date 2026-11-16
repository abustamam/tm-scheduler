/**
 * protects=the drain of queued role ops (#1638): which server fn an op maps
 * to, the expectedHolder it carries, the skip toast text, and that the queue
 * removal happens before the outcome is reported;
 * fails_when=an assign over a held slot calls claimSlot, expectedHolder is
 * dropped, a skip toast changes wording, or a skip stops the queue;
 * no_claim=the server's decision (slots-expected-holder.integration.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import {
	dispatchOp,
	drainMinutesQueue,
	type MinutesServerFns,
	ROLE_OP_OTHER_USER_MESSAGE,
	type RoleServerFns,
	roleSkipMessage,
} from "./drain-minutes";
import type { QueuedOp, RoleSlotOp } from "./offline-minutes-queue";
import { MEMBER_NOT_ELIGIBLE_MESSAGE } from "./write-proof";

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
		...over,
	}) as RoleSlotOp;
const release = (over: Partial<RoleSlotOp> = {}): RoleSlotOp =>
	({
		type: "releaseSlot",
		opId: "r1",
		queuedAt: 2,
		slotId: "s1",
		roleName: "Timer",
		expectedHolder: "m:ann",
		expectedHolderName: "Ann",
		...over,
	}) as RoleSlotOp;

function fns() {
	const role = {
		claimSlot: vi.fn().mockResolvedValue({ ok: true }),
		reassignSlot: vi.fn().mockResolvedValue({ ok: true }),
		releaseSlot: vi.fn().mockResolvedValue({ ok: true }),
	};
	return { role, all: role as unknown as MinutesServerFns & RoleServerFns };
}

describe("dispatchOp for role ops (#1638)", () => {
	it("an assign expecting an open slot claims, with the actor and expectedHolder", async () => {
		const f = fns();
		await dispatchOp(assign(), "m1", f.all);
		expect(f.role.claimSlot).toHaveBeenCalledWith({
			data: {
				slotId: "s1",
				memberId: "bob",
				actorMemberId: "adm",
				expectedHolder: null,
			},
		});
		expect(f.role.reassignSlot).not.toHaveBeenCalled();
	});

	it("an assign over a held slot reassigns with the holder the officer saw", async () => {
		const f = fns();
		await dispatchOp(
			assign({ expectedHolder: "m:ann", expectedHolderName: "Ann" }),
			"m1",
			f.all,
		);
		expect(f.role.reassignSlot).toHaveBeenCalledWith({
			data: { slotId: "s1", memberId: "bob", expectedHolder: "m:ann" },
		});
		expect(f.role.claimSlot).not.toHaveBeenCalled();
	});

	it("a release sends expectedHolder, a guest key included", async () => {
		const f = fns();
		await dispatchOp(release({ expectedHolder: "g:g1" }), "m1", f.all);
		expect(f.role.releaseSlot).toHaveBeenCalledWith({
			data: { slotId: "s1", expectedHolder: "g:g1" },
		});
	});

	it("a skip answer is an outcome, not a throw", async () => {
		const f = fns();
		f.role.claimSlot.mockResolvedValue({
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Zed",
			holderPresent: true,
		});
		const out = await dispatchOp(assign(), "m1", f.all);
		expect(out?.role).toMatchObject({
			outcome: "skipped",
			reason: "holder-changed",
			currentHolderName: "Zed",
		});
	});

	it("a role op with no role fns throws, so the op stays queued", async () => {
		await expect(
			dispatchOp(assign(), "m1", {} as MinutesServerFns),
		).rejects.toThrow();
	});
});

describe("roleSkipMessage (#1638)", () => {
	const o = (op: RoleSlotOp, extra: object) =>
		({ op, outcome: "skipped", currentHolderName: null, ...extra }) as never;
	it("names every case", () => {
		expect(
			roleSkipMessage(
				o(assign(), {
					reason: "holder-changed",
					currentHolderName: "Zed",
					holderPresent: true,
				}),
			),
		).toBe("Timer: kept Zed. Your offline change to Bob was not applied.");
		expect(
			roleSkipMessage(
				o(release(), {
					reason: "holder-changed",
					currentHolderName: "Zed",
					holderPresent: true,
				}),
			),
		).toBe("Timer: kept Zed. Your offline clear was not applied.");
		expect(
			roleSkipMessage(
				o(assign(), { reason: "holder-changed", holderPresent: false }),
			),
		).toBe(
			"Timer: was cleared online. Your offline change to Bob was not applied.",
		);
		expect(
			roleSkipMessage(
				o(release(), { reason: "holder-changed", holderPresent: false }),
			),
		).toBe("Timer: was cleared online. Your offline clear was not applied.");
		expect(roleSkipMessage(o(assign(), { reason: "slot-gone" }))).toBe(
			"Timer: that role was removed. Your offline change was not applied.",
		);
	});
});

describe("drainMinutesQueue with role ops (#1638)", () => {
	it("chained ops drain in order, each reported AFTER its removal, skips included", async () => {
		const f = fns();
		f.role.reassignSlot.mockResolvedValue({
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Zed",
			holderPresent: true,
		});
		const ops = [
			assign({ opId: "a1" }),
			assign({ opId: "a2", memberId: "cy", expectedHolder: "m:bob" }),
			release({ opId: "r1", expectedHolder: "m:cy" }),
		];
		const events: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops,
			dispatch: (op) => dispatchOp(op, "m1", f.all),
			onOpDrained: async (id, role) => {
				events.push(`removed:${id}:${role?.outcome}`);
			},
		});
		expect(events).toEqual([
			"removed:a1:applied",
			"removed:a2:skipped",
			"removed:r1:applied",
		]);
		expect(result.remaining).toEqual([]);
		expect(result.roleOutcomes?.map((r) => r.outcome)).toEqual([
			"applied",
			"skipped",
			"applied",
		]);
	});

	it("a replay of an already-applied op is an applied outcome (idempotent)", async () => {
		const f = fns();
		const first = await dispatchOp(assign(), "m1", f.all);
		const again = await dispatchOp(assign(), "m1", f.all);
		expect(first?.role?.outcome).toBe("applied");
		expect(again?.role?.outcome).toBe("applied");
	});

	it("a failing op (signed out) stays queued with its successors", async () => {
		const f = fns();
		f.role.claimSlot.mockRejectedValue(
			new Error("You need to be signed in to do that."),
		);
		const ops = [assign({ opId: "a1" }), release({ opId: "r1" })];
		const removed: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops,
			dispatch: (op) => dispatchOp(op, "m1", f.all),
			onOpDrained: async (id) => {
				removed.push(id);
			},
		});
		expect(removed).toEqual([]);
		expect(result.remaining.map((o) => o.opId)).toEqual(["a1", "r1"]);
		expect(result.error).toBeInstanceOf(Error);
	});
});

describe("W3, W1, W2 and R2 on the drain (#1638)", () => {
	const o = (op: RoleSlotOp, extra: object) =>
		({ op, outcome: "skipped", currentHolderName: null, ...extra }) as never;

	// protects=a holder whose name cannot be read is still reported as a holder:
	//   "kept the current holder", never "was cleared online";
	// fails_when=the toast keys on a null name instead of holderPresent;
	// no_claim=the server computing holderPresent (the integration suite).
	it("W3: a present holder with no readable name is not 'cleared online'", () => {
		expect(
			roleSkipMessage(
				o(assign(), {
					reason: "holder-changed",
					currentHolderName: null,
					holderPresent: true,
				}),
			),
		).toBe(
			"Timer: kept the current holder. Your offline change to Bob was not applied.",
		);
	});

	// protects=the drain carries a queued claim's speaker TBA to claimSlot, as the
	//   online sheet does, so the page ends in the same state;
	// fails_when=speakerDetails is dropped from the claim, or sent when absent;
	// no_claim=what the server does with it.
	it("W2: a queued TBA claim sends speakerDetails; one without sends none", async () => {
		const f = fns();
		await dispatchOp(
			assign({ speakerDetails: { speechTitle: "TBA" } }),
			"m1",
			f.all,
		);
		expect(f.role.claimSlot.mock.calls[0]?.[0].data.speakerDetails).toEqual({
			speechTitle: "TBA",
		});
		await dispatchOp(assign(), "m1", f.all);
		expect(
			"speakerDetails" in (f.role.claimSlot.mock.calls[1]?.[0]?.data ?? {}),
		).toBe(false);
	});

	// protects=an assign over an open slot with no actor never claims (it would
	//   otherwise be a claim by nobody, or by the session);
	// fails_when=the drain calls claimSlot with a null actor;
	// no_claim=a reassign, which sends no actor.
	it("W1: a claim with no actor throws instead of claiming", async () => {
		const f = fns();
		await expect(
			dispatchOp(assign({ actorMemberId: null }), "m1", f.all),
		).rejects.toThrow();
		expect(f.role.claimSlot).not.toHaveBeenCalled();
		// A reassign needs none.
		await dispatchOp(
			assign({ actorMemberId: null, expectedHolder: "m:ann" }),
			"m1",
			f.all,
		);
		expect(f.role.reassignSlot).toHaveBeenCalledTimes(1);
	});

	// protects=R2: a role op queued by member A is NOT replayed when member B is
	//   the one signed in (it would be B claiming for themselves, flipping B's
	//   decline); it stays queued with its successors and the drain stops;
	// fails_when=the drain ignores queuedBy, compares loosely, or dispatches
	//   before the check;
	// no_claim=the server's own authorization of the replay.
	it("R2: another member's queued role op is held, not dispatched", async () => {
		const f = fns();
		const ops = [
			assign({ opId: "a1", queuedBy: "officer-a" }),
			release({ opId: "r1", queuedBy: "officer-a" }),
		];
		const removed: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops,
			dispatch: (op) => dispatchOp(op, "m1", f.all, { memberId: "bob" }),
			onOpDrained: async (id) => {
				removed.push(id);
			},
		});
		expect(f.role.claimSlot).not.toHaveBeenCalled();
		expect(f.role.reassignSlot).not.toHaveBeenCalled();
		expect(f.role.releaseSlot).not.toHaveBeenCalled();
		expect(removed).toEqual([]);
		expect(result.remaining.map((x) => x.opId)).toEqual(["a1", "r1"]);
		expect(result.held?.map((x) => x.opId)).toEqual(["a1", "r1"]);
		expect(result.error).toBeUndefined();
	});

	// protects=the same member replays their own op, and a signed-out replay of
	//   an op queued signed in is held too;
	// fails_when=the check refuses the queuing member, or lets nobody through;
	// no_claim=an op queued with nobody signed in replaying for nobody.
	it("R2: the queuing member's own drain dispatches; signed out is held", async () => {
		const f = fns();
		await dispatchOp(assign({ queuedBy: "officer-a" }), "m1", f.all, {
			memberId: "officer-a",
		});
		expect(f.role.claimSlot).toHaveBeenCalledTimes(1);
		await expect(
			dispatchOp(assign({ queuedBy: "officer-a" }), "m1", f.all, {
				memberId: null,
			}),
		).rejects.toThrow(ROLE_OP_OTHER_USER_MESSAGE);
		expect(f.role.claimSlot).toHaveBeenCalledTimes(1);
	});
});

describe("R4: a permanent refusal leaves the queue (#1638)", () => {
	const refused = {
		ok: false,
		reason: "refused",
		message: MEMBER_NOT_ELIGIBLE_MESSAGE,
		currentHolderName: null,
	};

	// protects=a queued op the server refuses for good is dequeued with the
	//   toast text, and the ops behind it still drain;
	// fails_when=a refusal stops the drain (blocking the meeting's queue), or
	//   the toast loses the server's message;
	// no_claim=which server states count as permanent (the integration suite).
	it("is dequeued with a toast, and later ops still drain", async () => {
		const f = fns();
		f.role.claimSlot.mockResolvedValueOnce(refused);
		const ops = [assign({ opId: "a1" }), release({ opId: "r1" })];
		const removed: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops,
			dispatch: (op) => dispatchOp(op, "m1", f.all),
			onOpDrained: async (id) => {
				removed.push(id);
			},
		});
		expect(removed).toEqual(["a1", "r1"]);
		expect(result.remaining).toEqual([]);
		expect(result.error).toBeUndefined();
		expect(f.role.releaseSlot).toHaveBeenCalledTimes(1);
		const first = result.roleOutcomes?.[0];
		expect(first).toMatchObject({ outcome: "skipped", reason: "refused" });
		expect(first && roleSkipMessage(first)).toBe(
			`Timer: ${MEMBER_NOT_ELIGIBLE_MESSAGE.replace(/\.$/, "")}. Your offline change was not applied.`,
		);
	});

	// protects=nobody signed in, the R2 wrong-user hold and a network failure
	//   are NOT permanent: the op stays queued;
	// fails_when=any of them is treated as a refusal and dequeued;
	// no_claim=a deadlock (it surfaces as a thrown error like the network one).
	it.each([
		[
			"signed out",
			new Error("You need to be signed in to do that."),
			undefined,
		],
		["a network failure", new TypeError("Failed to fetch"), undefined],
		["another member's op", null, { memberId: "bob" }],
	])("%s stays queued", async (label, failure, session) => {
		const f = fns();
		if (failure) f.role.claimSlot.mockRejectedValue(failure);
		const ops = [assign({ opId: "a1", queuedBy: "officer-a" }), release()];
		const removed: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops,
			dispatch: (op) =>
				dispatchOp(op, "m1", f.all, session ?? { memberId: "officer-a" }),
			onOpDrained: async (id) => {
				removed.push(id);
			},
		});
		expect(removed).toEqual([]);
		expect(result.remaining.map((o) => o.opId)).toEqual(["a1", "r1"]);
		// The hold is not an error; a real failure still is.
		if (label === "another member's op") {
			expect(result.held).toHaveLength(2);
			expect(result.error).toBeUndefined();
		} else {
			expect(result.error).toBeInstanceOf(Error);
		}
	});
});

describe("a held role op does not block the queue behind it (#1638)", () => {
	const attendance = (opId = "t1"): QueuedOp => ({
		type: "setAttendance",
		opId,
		queuedAt: 3,
		memberId: "ann",
		status: "present",
	});
	const bob = { memberId: "bob" };
	const run = async (ops: QueuedOp[]) => {
		const f = fns();
		const minutes = vi.fn().mockResolvedValue(undefined);
		const removed: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops,
			dispatch: (op) =>
				dispatchOp(
					op,
					"m1",
					{ ...f.all, setAttendance: minutes } as never,
					bob,
				),
			onOpDrained: async (id) => {
				removed.push(id);
			},
		});
		return { f, minutes, removed, result };
	};

	// protects=option A: a role op held for another member leaves the queue
	//   behind it moving: attendance and minutes ops drain, the role op stays;
	// fails_when=the held op stops the drain (the old stop-on-failure);
	// no_claim=a MINUTES op that fails (still stops the drain, below).
	it("an attendance op behind it drains; the role op stays", async () => {
		const { minutes, removed, result } = await run([
			assign({ opId: "a1", queuedBy: "officer-a" }),
			attendance("t1"),
			attendance("t2"),
		]);
		expect(minutes).toHaveBeenCalledTimes(2);
		expect(removed).toEqual(["t1", "t2"]);
		expect(result.remaining.map((o) => o.opId)).toEqual(["a1"]);
		expect(result.held?.map((o) => o.opId)).toEqual(["a1"]);
		expect(result.error).toBeUndefined();
		expect(result.drainedCount).toBe(2);
	});

	// protects=role ops on ONE slot keep their order: a later op on the held
	//   op's slot is not dispatched ahead of it;
	// fails_when=the same-slot hold is dropped (the later release overtakes);
	// no_claim=other slots (next test).
	it("a later role op on the SAME slot stays queued behind it", async () => {
		const { f, removed, result } = await run([
			assign({ opId: "a1", slotId: "s1", queuedBy: "officer-a" }),
			release({ opId: "r1", slotId: "s1", queuedBy: "bob" }),
		]);
		expect(f.role.releaseSlot).not.toHaveBeenCalled();
		expect(removed).toEqual([]);
		expect(result.remaining.map((o) => o.opId)).toEqual(["a1", "r1"]);
		expect(result.held?.map((o) => o.opId)).toEqual(["a1", "r1"]);
	});

	// protects=a different slot is independent: it drains past the held op;
	// fails_when=the hold spreads to every role op;
	// no_claim=ordering across slots (none is promised).
	it("a role op on a DIFFERENT slot drains", async () => {
		const { f, removed, result } = await run([
			assign({ opId: "a1", slotId: "s1", queuedBy: "officer-a" }),
			release({ opId: "r2", slotId: "s2", queuedBy: "bob" }),
		]);
		expect(f.role.releaseSlot).toHaveBeenCalledTimes(1);
		expect(removed).toEqual(["r2"]);
		expect(result.remaining.map((o) => o.opId)).toEqual(["a1"]);
	});

	// protects=a held MINUTES op's neighbours: a real failure still stops the
	//   drain, and the held ops before it stay queued in their original order;
	// fails_when=a hard failure drops the held ops from `remaining`, or
	//   reorders them after it;
	// no_claim=the hold itself.
	it("a failing minutes op still stops the drain; held ops keep their place", async () => {
		const f = fns();
		const removed: string[] = [];
		const result = await drainMinutesQueue({
			meetingId: "m1",
			ops: [
				assign({ opId: "a1", queuedBy: "officer-a" }),
				attendance("t1"),
				attendance("t2"),
			],
			dispatch: (op) =>
				op.opId === "t1"
					? Promise.reject(new Error("boom"))
					: dispatchOp(op, "m1", f.all, bob),
			onOpDrained: async (id) => {
				removed.push(id);
			},
		});
		expect(removed).toEqual([]);
		expect(result.remaining.map((o) => o.opId)).toEqual(["a1", "t1", "t2"]);
		expect((result.error as Error).message).toBe("boom");
	});
});
