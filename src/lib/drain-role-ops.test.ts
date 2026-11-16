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
	type RoleServerFns,
	roleSkipMessage,
} from "./drain-minutes";
import type { RoleSlotOp } from "./offline-minutes-queue";

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
				o(assign(), { reason: "holder-changed", currentHolderName: "Zed" }),
			),
		).toBe("Timer: kept Zed. Your offline change to Bob was not applied.");
		expect(
			roleSkipMessage(
				o(release(), { reason: "holder-changed", currentHolderName: "Zed" }),
			),
		).toBe("Timer: kept Zed. Your offline clear was not applied.");
		expect(roleSkipMessage(o(assign(), { reason: "holder-changed" }))).toBe(
			"Timer: was cleared online. Your offline change to Bob was not applied.",
		);
		expect(roleSkipMessage(o(release(), { reason: "holder-changed" }))).toBe(
			"Timer: was cleared online. Your offline clear was not applied.",
		);
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
		expect(result.roleOutcomes.map((r) => r.outcome)).toEqual([
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
