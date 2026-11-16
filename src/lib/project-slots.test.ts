/**
 * protects=the offline projection (#1638): what the page and the deck show
 * while a role op is queued, and what a drained op keeps showing;
 * fails_when=an op stops mirroring its core, queue order is ignored, a
 * non-role queue changes identity, or the drained channel drifts from the
 * agenda channel;
 * no_claim=the server cores (see slots-expected-holder.integration.test.ts).
 */
import { describe, expect, it } from "vitest";
import { AGENDA_CHANNEL } from "#/lib/agenda-live";
import { DRAINED_CHANNEL } from "#/lib/drained-roles";
import type { MinutesOp, RoleSlotOp } from "#/lib/offline-minutes-queue";
import {
	type DrainedRoleOp,
	holderKeyOf,
	projectDrained,
	projectSlots,
} from "#/lib/project-slots";

type Slot = {
	id: string;
	status: string;
	assigneeName: string | null;
	assigneeId: string | null;
	assigneeGuestId: string | null;
	claimedAt: Date | null;
	speechTitle: string | null;
	holderPhone: string | null;
};

const open = (id = "s1"): Slot => ({
	id,
	status: "open",
	assigneeName: null,
	assigneeId: null,
	assigneeGuestId: null,
	claimedAt: null,
	speechTitle: null,
	holderPhone: null,
});
const held = (id = "s1"): Slot => ({
	...open(id),
	status: "confirmed",
	assigneeName: "Ann",
	assigneeId: "a",
	claimedAt: new Date(1000),
	speechTitle: "Talk",
	holderPhone: "555",
});

const assign = (over: Partial<RoleSlotOp> = {}): RoleSlotOp =>
	({
		type: "assignSlot",
		opId: "o1",
		queuedAt: 5000,
		slotId: "s1",
		roleName: "Timer",
		memberId: "b",
		memberDisplayName: "Bob",
		actorMemberId: "adm",
		expectedHolder: null,
		expectedHolderName: null,
		...over,
	}) as RoleSlotOp;
const release = (over: Partial<RoleSlotOp> = {}): RoleSlotOp =>
	({
		type: "releaseSlot",
		opId: "o2",
		queuedAt: 6000,
		slotId: "s1",
		roleName: "Timer",
		expectedHolder: "m:a",
		expectedHolderName: "Ann",
		...over,
	}) as RoleSlotOp;

describe("projectSlots (#1638)", () => {
	it("returns the same array when the queue has no role op", () => {
		const slots = [open()];
		const minutes = { type: "setAttendance" } as unknown as MinutesOp;
		expect(projectSlots(slots, [])).toBe(slots);
		expect(projectSlots(slots, [minutes])).toBe(slots);
	});

	it("claim of an open slot: holder set, claimed, claimedAt stamped", () => {
		const [s] = projectSlots([open()], [assign()]);
		expect(s).toMatchObject({
			assigneeName: "Bob",
			assigneeId: "b",
			status: "claimed",
			claimedAt: new Date(5000),
		});
	});

	it("reassign of a held slot: new holder, back to claimed, claimedAt kept, speech and contact cleared", () => {
		const [s] = projectSlots(
			[held()],
			[assign({ expectedHolder: "m:a", expectedHolderName: "Ann" })],
		);
		expect(s).toMatchObject({
			assigneeId: "b",
			status: "claimed",
			claimedAt: new Date(1000),
			speechTitle: null,
			holderPhone: null,
		});
	});

	it("release clears holder, speech and claimedAt and opens the slot", () => {
		const [s] = projectSlots([held()], [release()]);
		expect(s).toMatchObject({
			assigneeName: null,
			assigneeId: null,
			status: "open",
			claimedAt: null,
			speechTitle: null,
		});
	});

	it("a guest-held slot can be released", () => {
		const g = { ...open(), assigneeGuestId: "g1", assigneeName: "Gus" };
		const [s] = projectSlots(
			[g],
			[release({ expectedHolder: "g:g1", expectedHolderName: "Gus" })],
		);
		expect(s?.assigneeGuestId).toBeNull();
		expect(s?.status).toBe("open");
	});

	it("applies in queue order, so a second edit chains off the first", () => {
		const [s] = projectSlots(
			[open()],
			[
				assign(),
				assign({
					opId: "o3",
					memberId: "c",
					memberDisplayName: "Cy",
					expectedHolder: "m:b",
				}),
				release({ opId: "o4", expectedHolder: "m:c" }),
			],
		);
		expect(s?.status).toBe("open");
		const [t] = projectSlots(
			[open()],
			[
				assign(),
				assign({
					opId: "o3",
					memberId: "c",
					memberDisplayName: "Cy",
					expectedHolder: "m:b",
				}),
			],
		);
		expect(t?.assigneeName).toBe("Cy");
	});

	it("ignores an op for a slot not in the list and leaves other slots alone", () => {
		const a = open("s1");
		const b = held("s2");
		const out = projectSlots([a, b], [assign({ slotId: "s9" })]);
		expect(out).toEqual([a, b]);
	});

	it("holderKeyOf prefers the guest key", () => {
		expect(holderKeyOf({ assigneeId: "a", assigneeGuestId: "g" })).toBe("g:g");
		expect(holderKeyOf({ assigneeId: "a" })).toBe("m:a");
		expect(holderKeyOf({})).toBeNull();
	});
});

describe("projectDrained (#1638)", () => {
	const d = (over: Partial<DrainedRoleOp>): DrainedRoleOp => ({
		op: assign(),
		outcome: "applied",
		currentHolderName: null,
		...over,
	});

	it("an applied op keeps projecting over a stale server copy", () => {
		const [s] = projectDrained([open()], [d({})]);
		expect(s?.assigneeName).toBe("Bob");
	});

	it("a skipped op shows who holds the slot now", () => {
		const [s] = projectDrained(
			[held()],
			[d({ outcome: "skipped", currentHolderName: "Zed" })],
		);
		expect(s?.assigneeName).toBe("Zed");
	});

	it("a skipped op whose answer is nobody shows the slot open", () => {
		const [s] = projectDrained([held()], [d({ outcome: "skipped" })]);
		expect(s?.status).toBe("open");
		expect(s?.assigneeName).toBeNull();
	});

	it("no drained ops returns the same array", () => {
		const slots = [open()];
		expect(projectDrained(slots, [])).toBe(slots);
	});
});

describe("drained channel (#1638)", () => {
	it("equals the agenda channel", () => {
		expect(DRAINED_CHANNEL).toBe(AGENDA_CHANNEL);
	});
});
