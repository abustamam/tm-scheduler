import { describe, expect, it } from "vitest";
import { buildHeldRoleLabels } from "./held-role-labels";

type Slot = Parameters<typeof buildHeldRoleLabels>[0][number];

function slot(over: Partial<Slot> = {}): Slot {
	return {
		roleName: "Timer",
		slotIndex: 0,
		assigneeId: null,
		assigneeName: null,
		...over,
	};
}

describe("buildHeldRoleLabels (#663)", () => {
	it("keys by MEMBER, not by slot", () => {
		// The mutation that produces an empty map and so silences every confirm —
		// the release still lands, with nothing warning about it, which is the bug
		// #663 exists to close wearing a different hat.
		const map = buildHeldRoleLabels([
			slot({ roleName: "Toastmaster", assigneeId: "m1", assigneeName: "Ana" }),
		]);
		expect(Object.keys(map)).toEqual(["m1"]);
		expect(map.m1).toEqual({ name: "Ana", labels: ["Toastmaster"] });
	});

	it("collects EVERY role one member holds, in payload order", () => {
		// Double-booking is deliberate product behaviour, and it is exactly the
		// case the dialog's copy exists for: the officer has to be told about both
		// before both are freed.
		const map = buildHeldRoleLabels([
			slot({ roleName: "Toastmaster", assigneeId: "m1", assigneeName: "Ana" }),
			slot({ roleName: "Timer", assigneeId: "m1", assigneeName: "Ana" }),
		]);
		expect(map.m1?.labels).toEqual(["Toastmaster", "Timer"]);
	});

	it("numbers a repeated role, so two evaluator slots are distinguishable", () => {
		// Unnumbered, the dialog says "This frees Evaluator and Evaluator" and the
		// officer cannot tell what they are about to empty. Passes a grep for
		// `slotLabel`; fails only an assertion on the string.
		const map = buildHeldRoleLabels([
			slot({ roleName: "Evaluator", slotIndex: 0, assigneeId: "m1" }),
			slot({ roleName: "Evaluator", slotIndex: 1, assigneeId: "m2" }),
		]);
		expect(map.m1?.labels).toEqual(["Evaluator 1"]);
		expect(map.m2?.labels).toEqual(["Evaluator 2"]);
	});

	it("numbers a role off every slot it HAS, including the open ones", () => {
		// The filtered-call mutation: counting only ASSIGNED slots renumbers the
		// labels as the week fills, so the same slot reads "Evaluator" today and
		// "Evaluator 1" once someone claims the other one.
		const map = buildHeldRoleLabels([
			slot({ roleName: "Evaluator", slotIndex: 0, assigneeId: "m1" }),
			slot({ roleName: "Evaluator", slotIndex: 1, assigneeId: null }),
		]);
		expect(map.m1?.labels).toEqual(["Evaluator 1"]);
	});

	it("omits members who hold nothing, and guest-held slots", () => {
		// Absence IS the signal: the caller reads "not in this map" as "no confirm,
		// write straight through". A guest has no attendance rung to decline, and
		// their slot carries a null member id.
		const map = buildHeldRoleLabels([
			slot({ roleName: "Speaker", assigneeId: null, assigneeName: "A Guest" }),
		]);
		expect(map).toEqual({});
	});

	it("keeps the first slot's assignee name", () => {
		const map = buildHeldRoleLabels([
			slot({ roleName: "Toastmaster", assigneeId: "m1", assigneeName: "Ana" }),
			slot({ roleName: "Timer", assigneeId: "m1", assigneeName: "Ana" }),
		]);
		expect(map.m1?.name).toBe("Ana");
	});
});
